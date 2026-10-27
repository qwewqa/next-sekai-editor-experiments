import { expect, type Browser } from '@playwright/test'
import { readNxsp } from '../../src/local/nxsp'
import { fast } from './contextA'
import type { Products } from './products'
import { selectTool, tapAt } from './ui'
import { DAY, Profile, readOpfs, START, writeOpfs, type Row } from './world'

// Context B: a write-back browser on another device (scenario: B). It opens step 6's file and saves
// it back (`full.nxsp`); then the file on its disk is replaced by step 10's, and a Save's Replace
// keeps the file's versions first (`kept-first.nxsp`).

const hour = 60 * 60 * 1000
const fileName = 'full.nxsp'

export const readFile = async (bytes: Uint8Array) => {
    const read = await readNxsp(new Blob([new Uint8Array(bytes)]))
    if (read.kind !== 'nxsp' || !read.history) throw new Error('A file with history was expected')
    return { ...read, history: read.history, revision: (read.projectJson.revision ?? {}) as Row }
}

export const runB = async (browser: Browser, products: Products) => {
    const profile = await Profile.create(browser, {
        start: START + 2 * DAY + 5 * hour,
        files: 'opfs',
    })
    const blank = await profile.blank()
    await writeOpfs(blank, fileName, products.bytes('step6.nxsp'))
    await blank.close()
    const tab = await profile.visit()
    await tab.open(fileName)
    await expect(tab.notice(`Opened ${fileName}`)).toBeVisible()
    await expect
        .poll(
            async () =>
                (await tab.stored('sessions')).filter((row) => row.importPending === true).length,
        )
        .toBe(0)
    await selectTool(tab, 'a', 'note')
    await tab.focus(1500)
    await tapAt(tab, 0, 1500)
    await tab.page.keyboard.press('p')
    await expect(tab.notice(`Saved to ${fileName}`)).toBeVisible()
    await tab.stored_()

    // full.nxsp: A's file written back by another device.
    const full = await readOpfs(tab.page, fileName)
    const first = await readFile(full)
    expect(first.open).toBe('full')
    const saves = first.history.entries.filter((entry) => entry.kind === 'save')
    expect(new Set(saves.map((entry) => entry.device?.id)).size).toBe(2)
    const stepSix = await readFile(products.bytes('step6.nxsp'))
    // Carried: the first history write's revision, an ancestor of this one.
    expect(first.revision.completeFrom).toBe(stepSix.revision.completeFrom)
    expect(first.revision.completeFrom).not.toBe(first.revision.id)
    if (!fast) expect((first.projectJson.history as Row).segments).toBeDefined()
    products.put('full.nxsp', full)

    // The file on this disk is replaced by step 10's; the next Save's conflict dialog: Replace.
    await profile.clock.passTo(START + 4 * DAY + 5 * hour)
    await writeOpfs(tab.page, fileName, products.bytes('step10.nxsp'))
    await tapAt(tab, 0, 1504)
    await tab.page.keyboard.press('p')
    const dialog = tab.page.getByRole('dialog')
    await expect(dialog).toContainText(`“${fileName}” Changed`)
    // Past the dialog's activation guard.
    await tab.page.waitForTimeout(400)
    await dialog.getByRole('button', { name: 'Replace' }).click()
    await expect
        .poll(
            async () => {
                const read = await readNxsp(
                    new Blob([new Uint8Array(await readOpfs(tab.page, fileName))]),
                )
                return read.kind === 'nxsp'
                    ? (read.projectJson.revision as Row).replaces
                    : undefined
            },
            { timeout: 15_000 },
        )
        .toBeDefined()
    await tab.stored_()
    const keptFirst = await readOpfs(tab.page, fileName)
    const second = await readFile(keptFirst)
    expect(second.open).toBe('full')
    const stepTen = await readFile(products.bytes('step10.nxsp'))
    expect(second.revision.replaces).toBe(stepTen.revision.id)
    products.put('kept-first.nxsp', keptFirst)
    await profile.close()
}
