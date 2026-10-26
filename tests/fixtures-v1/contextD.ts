import { expect, type Browser } from '@playwright/test'
import { createHash } from 'node:crypto'
import { confirmWhenReady } from '../browser/confirmWhenReady'
import { saveDialog, submitSave } from '../browser/saveFlows'
import { badChunksOf, BUILD } from './contextA'
import { readFile } from './contextB'
import type { Products } from './products'
import { redo, saveAs, selectTool, tapAt, undo, wav } from './ui'
import { DAY, downloaded, openBytes, Profile, START, type Row, type Tab } from './world'

// Context D: a download browser on a third device (scenario: D). It opens `full.nxsp`, and its Saves
// download: `carried.nxsp`, `not-carried.nxsp` (a chunk found bad), `media-not-held.nxsp` (after Undo
// to a state whose media this browser does not hold) and `bgm-unticked.nxsp`.

const hour = 60 * 60 * 1000
const fileName = 'full.nxsp'

const bgmHash = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex').slice(0, 32)

const liveBgmHash = (tab: Tab) =>
    tab.page.evaluate(async () => {
        const { liveState } =
            (await import('/src/history/stack.ts')) as typeof import('../../src/history/stack')
        return liveState.value.bgm.meta?.hash
    })

export const runD = async (browser: Browser, products: Products) => {
    const profile = await Profile.create(browser, {
        start: START + 5 * DAY + 4 * hour,
        files: 'download',
    })
    const tab = await profile.visit()
    await openBytes(tab, fileName, products.bytes('full.nxsp'))
    await expect(tab.notice(`Opened ${fileName}`)).toBeVisible()
    await expect
        .poll(
            async () =>
                (await tab.stored('sessions')).filter((row) => row.importPending === true).length,
        )
        .toBe(0)
    const full = await readFile(products.bytes('full.nxsp'))
    await selectTool(tab, 'a', 'note')

    // carried.nxsp: a Save rebuilds the file from storage and carries the base's completeFrom.
    await tapAt(tab, 0, 1600)
    const carried = await downloaded(tab, async () => {
        await tab.page.keyboard.press('p')
        await expect(saveDialog(tab.page)).toBeVisible()
        await submitSave(tab.page)
    })
    const carriedRead = await readFile(carried.bytes)
    expect(carriedRead.open).toBe('full')
    expect(carriedRead.revision.completeFrom).toBe(full.revision.completeFrom)
    expect(carriedRead.revision.completeFrom).not.toBe(carriedRead.revision.id)
    products.put('carried.nxsp', carried.bytes)
    await tab.stored_()
    expect((await tab.chain()).file).toMatchObject({ event: 'downloaded' })

    // not-carried.nxsp: a stored chunk only a row full.nxsp held goes bad; the next Save finds it.
    const { chainId } = await tab.chain()
    const imported = (await tab.stored('sessions')).find(
        (row) => row.chainId === chainId && row.origin === 'nxsp',
    )
    const rows = (await tab.stored('entries'))
        .filter((row) => row.sessionId === imported!.id && row.kind === 'edit')
        .sort((a, b) => (a.seq as number) - (b.seq as number))
    let damaged: string | undefined
    for (const row of rows) {
        damaged = await tab.page.evaluate(
            (key) =>
                window.nseStorageTest!.worker.call('testDamage', key) as Promise<
                    string | undefined
                >,
            { sessionId: row.sessionId as string, seq: row.seq as number },
        )
        if (damaged) break
    }
    expect(damaged).toMatch(/^[0-9a-f]{32}$/)
    await tapAt(tab, 0, 1604)
    const notCarried = await downloaded(tab, () => tab.page.keyboard.press('p'))
    const notCarriedRead = await readFile(notCarried.bytes)
    expect(notCarriedRead.open).toBe('full')
    expect(notCarriedRead.revision.completeFrom).toBe(notCarriedRead.revision.id)
    // The row damaged here, and the one full.nxsp already held not kept.
    expect(notCarriedRead.history.entries.filter((entry) => entry.kept === false)).toHaveLength(
        full.history.entries.filter((entry) => entry.kept === false).length + 1,
    )
    products.put('not-carried.nxsp', notCarried.bytes)
    await tab.stored_()
    const chain = await tab.chain()
    expect(badChunksOf(chain)).toContain(damaged)

    // media-not-held.nxsp: Undo to the state before step 6's media; none of the three is held here.
    const first = bgmHash(wav(2, 5))
    let undone = 0
    while ((await liveBgmHash(tab)) !== first) {
        if (++undone > 12) throw new Error('Undo did not reach the first BGM')
        await undo(tab)
    }
    const notHeld = await downloaded(tab, () => saveAs(tab, { name: 'media-not-held' }))
    const notHeldRead = await readFile(notHeld.bytes)
    const project = notHeldRead.projectJson
    const forms = [
        project.bgm,
        (project.metadata as Row).cover,
        (project.metadata as Row).preview,
    ] as Row[]
    for (const form of forms) {
        expect(form).toBeDefined()
        expect(form.file).toBeUndefined()
        expect(form).toMatchObject({
            hash: expect.any(String),
            size: expect.any(Number),
            type: expect.any(String),
        })
    }
    products.put('media-not-held.nxsp', notHeld.bytes)
    await tab.stored_()

    // bgm-unticked.nxsp: back at the head, whose BGM is held, Save As… without it.
    await redo(tab, undone)
    const unticked = await downloaded(tab, () => saveAs(tab, { name: 'bgm-unticked', bgm: false }))
    const untickedRead = await readFile(unticked.bytes)
    expect(untickedRead.projectJson.bgm).toBeUndefined()
    // The head records a BGM (the file does not hold it).
    expect(untickedRead.history.headRecords.header[8]).toBeDefined()
    products.put('bgm-unticked.nxsp', unticked.bytes)
    await tab.stored_()
    // The last download is confirmed. Reopening it is no confirmation here: the chain has damaged
    // parts (`badChunks`), and an open of a chain's own last write needs none (history-format 3.4),
    // so the chip's I Have the File does it.
    const chip = tab.page.locator('[data-file-chip]')
    await expect(chip).toHaveAttribute('data-file-chip', 'notConfirmed')
    await chip.click()
    const dialog = tab.page.getByRole('dialog', { name: 'Download Not Confirmed' })
    await expect(dialog).toBeVisible()
    await confirmWhenReady(dialog.getByRole('button', { name: 'I Have the File' }), dialog)
    await expect(chip).toBeHidden()
    await tab.stored_()
    const bound = (await tab.chain()).file as Row
    expect(bound).toMatchObject({ event: 'downloaded', confirmed: true })
    await tab.leave()
    return profile.dump(BUILD)
}
