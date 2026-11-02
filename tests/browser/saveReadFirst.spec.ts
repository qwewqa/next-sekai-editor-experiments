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
    release,
    saveDialog,
    start,
    submitSave,
    thinUndone,
} from './saveFlows'

// Save As builds from the stored session before the picker, even when its file holds more.

type Row = Record<string, unknown>

test('after a reload with history missing from storage: Save As writes a new document without asking to read the file', async ({
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
        void runCommand(commands.saveAs, 'button')
    })
    await expect(saveDialog(page, 'Save As')).toBeVisible()
    expect(await pickerCalls(page)).toEqual([])
    await queuePicks(page, ['coconut.nxsp'])
    await submitSave(page, undefined, 'Save As')
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    await expect(
        notice(page).filter({ hasText: 'Some earlier Timeline steps were not kept.' }),
    ).toBeVisible()
    expect((await pickerCalls(page)).map((call) => call.picker)).toEqual(['save'])
    const after = await projectOf(page, 'coconut.nxsp')
    expect(after.id).not.toBe(before.id)
    const revision = after.revision as Row
    expect(revision.parent).toBeNull()
    expect(revision.ancestors).toEqual([])
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
        void runCommand(commands.saveAs, 'button')
    })
    await expect(saveDialog(page, 'Save As')).toBeVisible()
    await page.waitForTimeout(500)
    expect(await pickerCalls(page)).toEqual([])
})

const saveAs = (page: import('@playwright/test').Page) =>
    page.evaluate(async () => {
        const { commands } = await import('/src/editor/commands/index.ts')
        const { runCommand } = await import('/src/editor/commands/runCommand.ts')
        void runCommand(commands.saveAs, 'button')
    })

test('Save As onto its own file uses the chosen History option even if a rename rebuild fails', async ({
    page,
}) => {
    await start(page)
    await editPastUndo(page, 1)
    await pressSave(page)
    await submitSave(page, 'coconut')
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    const before = await projectOf(page, 'coconut.nxsp')
    await saveAs(page)
    const dialog = saveDialog(page, 'Save As')
    await dialog.getByRole('checkbox', { name: 'History' }).uncheck()
    await queuePicks(page, ['coconut.nxsp'])
    await pauseAt(page, 'picked')
    await submitSave(page, undefined, 'Save As')
    await reached(page, 'picked')
    await builds(page, 'fail')
    await release(page)
    await expect(notice(page).filter({ hasText: 'Saved to coconut.nxsp' })).toBeVisible()
    const after = await projectOf(page, 'coconut.nxsp')
    expect(after.id).not.toBe(before.id)
    expect((after.revision as Row).parent).toBeNull()
    expect(after.history).toBeUndefined()
})
