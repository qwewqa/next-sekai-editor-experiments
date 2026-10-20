import { expect, test, type Page } from '@playwright/test'
import { waitForStartup } from './editorFixture'
import {
    edit,
    flushed,
    notice,
    pickerCalls,
    pressSave,
    projectOf,
    queuePicks,
    rows,
    saveDialog,
    sessionOf,
    start,
    submitSave,
} from './saveFlows'

// Damage in storage that no build has seen yet (SP-1; Part 1 §1.6.11.6, §1.4.7 R2): a bad stored
// head chunk never refuses a Save, the head is written from the live records; and when the build
// made before the picker finds damage, the chain's own file is read before the picker opens, so a
// pick of it appends to what it holds and nothing it held is lost.

type Row = Record<string, unknown>

/** The stored rows of the open session, in `seq` order. */
const ownRows = async (page: Page) => {
    await flushed(page)
    const { sessionId } = await sessionOf(page)
    const { entries } = await rows(page, ['entries'])
    return entries!
        .map((row) => row.value)
        .filter((row) => row.sessionId === sessionId)
        .sort((a, b) => (a.seq as number) - (b.seq as number))
}

/** A byte of a stored chunk only this row's state needs goes bad (the worker's test hook). */
const damage = async (page: Page, row: Row) => {
    const hash = await page.evaluate(
        (key) => window.nseStorageTest!.worker.call('testDamage', key) as Promise<string>,
        { sessionId: row.sessionId as string, seq: row.seq as number },
    )
    expect(hash).toBeTruthy()
}

const runSaveAs = (page: Page) =>
    page.evaluate(async () => {
        const { commands } = await import('/src/editor/commands/index.ts')
        const { runCommand } = await import('/src/editor/commands/runCommand.ts')
        void runCommand(commands.saveAs)
    })

test('a bad stored head chunk never refuses a Save: the head is written from the live state', async ({
    page,
}) => {
    await start(page)
    await edit(page, 1)
    await edit(page, 2)
    const head = (await ownRows(page)).at(-1)!
    expect(head.kind).toBe('edit')
    await damage(page, head)
    await pressSave(page)
    await submitSave(page, 'coconut')
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    await expect(notice(page).filter({ hasText: 'could not be read completely' })).toHaveCount(0)
    const project = await projectOf(page, 'coconut.nxsp')
    expect((project.revision as Row).id).toBeTruthy()
})

test('damage the build before the picker finds: the own file is read first and appended to', async ({
    page,
}) => {
    await start(page)
    await edit(page, 1)
    await edit(page, 2)
    await pressSave(page)
    await submitSave(page, 'coconut')
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    const before = await projectOf(page, 'coconut.nxsp')
    await edit(page, 3)
    // A state only the file's earlier row has: storage looks whole, so nothing reads it first.
    const first = (await ownRows(page)).find((row) => row.kind === 'edit')!
    await damage(page, first)
    await runSaveAs(page)
    await expect(saveDialog(page, 'Save As')).toBeVisible()
    await queuePicks(page, ['coconut.nxsp'])
    await submitSave(page, undefined, 'Save As')
    await expect
        .poll(async () => ((await projectOf(page, 'coconut.nxsp')).revision as Row).n)
        .toBe(2)
    await expect(notice(page).filter({ hasText: 'Some earlier steps were not kept.' })).toHaveCount(
        0,
    )
    const after = await projectOf(page, 'coconut.nxsp')
    expect(after.id).toBe(before.id)
    const revision = after.revision as Row
    expect(revision.parent).toBe((before.revision as Row).id)
    // An append: the file's base is carried, so every step it held is still in it.
    expect(revision.completeFrom).toBe((before.revision as Row).completeFrom)
    // No permission was asked for: the grant this page load holds read it.
    expect((await pickerCalls(page)).some((call) => call.picker === 'permission')).toBe(false)
})

test('the same damage without a held grant: no prompt before the picker, and the line shows', async ({
    page,
}) => {
    await start(page)
    await edit(page, 1)
    await edit(page, 2)
    await pressSave(page)
    await submitSave(page, 'coconut')
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    await edit(page, 3)
    const first = (await ownRows(page)).find((row) => row.kind === 'edit')!
    await damage(page, first)
    // After a reload read access is a prompt again.
    await page.evaluate(() => {
        localStorage.setItem('nse.test.readPermission', 'prompt')
        localStorage.setItem('nse.test.pickerCalls', '[]')
    })
    await page.reload()
    await waitForStartup(page)
    await runSaveAs(page)
    await expect(saveDialog(page, 'Save As')).toBeVisible()
    await queuePicks(page, ['coconut.nxsp'])
    await submitSave(page, undefined, 'Save As')
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    await expect
        .poll(async () => ((await projectOf(page, 'coconut.nxsp')).revision as Row).n)
        .toBe(2)
    // A prompt between the press and the picker would spend the press the picker needs.
    expect((await pickerCalls(page)).map((call) => call.picker)).toEqual(['save'])
    await expect(
        notice(page).filter({ hasText: 'Some earlier steps were not kept.' }),
    ).toBeVisible()
})

test('the Save dialog opens though the worker doesn’t answer whether it holds the BGM', async ({
    page,
}) => {
    await start(page, { fileSystemAccess: false })
    await edit(page, 1)
    await page.evaluate(async () => {
        const { pushState, state } = await import('/src/history/index.ts')
        const { captureMedia } = await import('/src/local/media.ts')
        const { bgmOperation } = await import('/src/editor/headerLabels.ts')
        const bytes = crypto.getRandomValues(new Uint8Array(4096))
        const captured = await captureMedia(bytes.buffer, { name: 'song.mp3', type: 'audio/mpeg' })
        const next = {
            ...state.value.bgm,
            filename: 'song.mp3',
            meta: captured.meta,
            source: captured.source,
        }
        pushState(bgmOperation(state.value.bgm, next), { ...state.value, bgm: next })
    })
    await flushed(page)
    await page.reload()
    await waitForStartup(page)
    await page.evaluate(async () => {
        const { storageWorker } = await import('/src/local/start.ts')
        const worker = storageWorker!
        const call = worker.call.bind(worker)
        const calls: string[] = []
        ;(window as unknown as { calls: string[] }).calls = calls
        worker.call = ((method: string, ...rest: unknown[]) => {
            calls.push(method)
            // A worker that never answers whether it holds the BGM, however it's asked.
            if (method === 'mediaHeld' || method === 'saveNeeds')
                return new Promise(() => undefined)
            return (call as (...args: unknown[]) => unknown)(method, ...rest)
        }) as typeof worker.call
    })
    await pressSave(page)
    await expect(saveDialog(page)).toBeVisible({ timeout: 3000 })
    const calls = await page.evaluate(() => (window as unknown as { calls: string[] }).calls)
    expect(calls).toContain('mediaHeld')
    expect(calls).not.toContain('saveNeeds')
})
