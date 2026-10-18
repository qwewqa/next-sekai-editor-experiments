import { expect, test } from '@playwright/test'
import { waitForStartup } from './editorFixture'
import {
    editPastUndo,
    notice,
    pickerCalls,
    pressSave,
    projectOf,
    queuePicks,
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
    await expect(notice(page).filter({ hasText: 'Some earlier steps were not kept.' })).toHaveCount(
        0,
    )
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
