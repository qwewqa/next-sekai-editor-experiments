import { expect, test } from '@playwright/test'
import { waitForStartup } from './editorFixture'
import {
    builds,
    editPastUndo,
    notice,
    pauseAt,
    pickerCalls,
    pressSave,
    projectOf,
    queuePicks,
    reached,
    readFile,
    release,
    saveDialog,
    start,
    submitSave,
    thinUndone,
} from './saveFlows'

// R2 as written (Part 1 §1.4.7; owner decision log D26): the Save As… dialog reads the chain's own
// file before its picker when storage lacks rows the file holds, asking for read access when it
// opens if it isn't granted, so a pick of that file appends to what was read and keeps every
// earlier step.

type Row = Record<string, unknown>

test('storage short after a reload: Save As… asks to read the file, and a pick of it keeps every step', async ({
    page,
}) => {
    await start(page)
    await editPastUndo(page, 1)
    await pressSave(page)
    await submitSave(page, 'coconut')
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    const before = await projectOf(page, 'coconut.nxsp')
    // Cleanup took a row the file holds.
    expect(await thinUndone(page)).toBe(true)

    // After a reload read access is a prompt again.
    await page.evaluate(() => {
        localStorage.setItem('nse.test.readPermission', 'prompt')
        localStorage.setItem('nse.test.pickerCalls', '[]')
    })
    await page.reload()
    await waitForStartup(page)
    await page.evaluate(async () => {
        const { commands } = await import('/src/editor/commands/index.ts')
        const { runCommand } = await import('/src/editor/commands/runCommand.ts')
        void runCommand(commands.saveAs)
    })
    await expect(saveDialog(page, 'Save As')).toBeVisible()
    // Asked when the dialog opened, before any picker.
    await expect
        .poll(async () => (await pickerCalls(page)).map((call) => call.picker))
        .toEqual(['permission'])
    await page.waitForTimeout(300)
    await queuePicks(page, ['coconut.nxsp'])
    await submitSave(page, undefined, 'Save As')
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    await expect(
        notice(page).filter({ hasText: 'Some earlier Timeline steps were not kept.' }),
    ).toHaveCount(0)
    expect((await pickerCalls(page)).map((call) => call.picker)).toEqual(['permission', 'save'])
    const after = await projectOf(page, 'coconut.nxsp')
    expect(after.id).toBe(before.id)
    const revision = after.revision as Row
    expect(revision.parent).toBe((before.revision as Row).id)
    // An append: the file's base is carried.
    expect(revision.completeFrom).toBe((before.revision as Row).completeFrom)
})

test('storage holding everything: Save As… asks for nothing', async ({ page }) => {
    await start(page)
    await editPastUndo(page, 1)
    await pressSave(page)
    await submitSave(page, 'coconut')
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    await page.evaluate(() => {
        localStorage.setItem('nse.test.readPermission', 'prompt')
        localStorage.setItem('nse.test.pickerCalls', '[]')
    })
    await page.reload()
    await waitForStartup(page)
    await page.evaluate(async () => {
        const { commands } = await import('/src/editor/commands/index.ts')
        const { runCommand } = await import('/src/editor/commands/runCommand.ts')
        void runCommand(commands.saveAs)
    })
    await expect(saveDialog(page, 'Save As')).toBeVisible()
    await page.waitForTimeout(500)
    expect(await pickerCalls(page)).toEqual([])
})

const saveAs = (page: import('@playwright/test').Page) =>
    page.evaluate(async () => {
        const { commands } = await import('/src/editor/commands/index.ts')
        const { runCommand } = await import('/src/editor/commands/runCommand.ts')
        void runCommand(commands.saveAs)
    })

test('a pick of the chain’s own file whose append then fails gets the bytes read back (SF-1)', async ({
    page,
}) => {
    await start(page)
    await editPastUndo(page, 1)
    await pressSave(page)
    await submitSave(page, 'coconut')
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    const before = await readFile(page, 'coconut.nxsp')
    expect(before?.length).toBeGreaterThan(0)
    // Storage short: the dialog reads the file first.
    expect(await thinUndone(page)).toBe(true)
    await saveAs(page)
    await expect(saveDialog(page, 'Save As')).toBeVisible()
    await page.waitForTimeout(300)
    await queuePicks(page, ['coconut.nxsp'])
    await pauseAt(page, 'picked')
    await submitSave(page, undefined, 'Save As')
    await reached(page, 'picked')
    // The picker emptied the file; the append from the bytes read fails (a worker restart).
    expect(await readFile(page, 'coconut.nxsp')).toEqual([])
    await builds(page, 'fail')
    await release(page)
    await expect(page.getByRole('dialog')).toContainText('coconut.nxsp')
    await expect.poll(() => readFile(page, 'coconut.nxsp')).toEqual(before)
    await builds(page, undefined)
})

test('Save As… picking the chain’s own file with nothing read: a rebuild that failed once is tried again, keeping the file’s identity and History (SF2-2, ADV-4)', async ({
    page,
}) => {
    await start(page)
    await editPastUndo(page, 1)
    await pressSave(page)
    await submitSave(page, 'coconut')
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    const before = await projectOf(page, 'coconut.nxsp')
    // Storage holds everything: nothing is read first. Save As… without History.
    await saveAs(page)
    const dialog = saveDialog(page, 'Save As')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('checkbox', { name: 'History' }).uncheck()
    await queuePicks(page, ['coconut.nxsp'])
    await pauseAt(page, 'picked')
    await submitSave(page, undefined, 'Save As')
    await reached(page, 'picked')
    await builds(page, 'failOnce')
    await release(page)
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    await builds(page, undefined)
    // The file's own identity, its History, and its revision lineage, never Save As…'s.
    const after = await projectOf(page, 'coconut.nxsp')
    expect(after.id).toBe(before.id)
    expect((after.revision as Row).parent).toBe((before.revision as Row).id)
    expect((after.history as Row | undefined)?.entries).toBeGreaterThan(0)
})

test('Save As… picking the chain’s own file with nothing read: a rebuild that keeps failing never writes Save As…’s identity, and the next Save fills it (SF2-2)', async ({
    page,
}) => {
    await start(page)
    await editPastUndo(page, 1)
    await pressSave(page)
    await submitSave(page, 'coconut')
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    const before = await projectOf(page, 'coconut.nxsp')
    await saveAs(page)
    await expect(saveDialog(page, 'Save As')).toBeVisible()
    await queuePicks(page, ['coconut.nxsp'])
    await pauseAt(page, 'picked')
    await submitSave(page, undefined, 'Save As')
    await reached(page, 'picked')
    await builds(page, 'fail')
    await release(page)
    // Shown as not written; storage holds all the file did, so it's left empty (R9).
    const failed = page.getByRole('dialog').filter({ hasText: 'coconut.nxsp' })
    await expect(failed).toBeVisible()
    expect(await readFile(page, 'coconut.nxsp')).toEqual([])
    await page.keyboard.press('Escape')
    await expect(failed).toHaveCount(0)
    await builds(page, undefined)
    await pressSave(page)
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    const after = await projectOf(page, 'coconut.nxsp')
    expect(after.id).toBe(before.id)
    expect((after.history as Row | undefined)?.entries).toBeGreaterThan(0)
})
