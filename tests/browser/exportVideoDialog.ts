import { expect, type Page } from '@playwright/test'

type DialogOptions = Parameters<
    (typeof import('../../src/editor/exportVideo/test'))['openExportVideoTest']
>[0]

export const openVideoDialog = async (page: Page, options: DialogOptions = {}) => {
    await page.evaluate(async (options) => {
        const { openExportVideoTest } = await window.editorTest.appImport<
            typeof import('../../src/editor/exportVideo/test')
        >('/src/editor/exportVideo/test.ts')
        await openExportVideoTest(options)
    }, options)
    const dialog = videoDialog(page)
    await expect(dialog).toBeVisible()
    return dialog
}

export const videoDialog = (page: Page) => page.locator('dialog:has([data-export-form])')
export const videoPhase = (page: Page) =>
    videoDialog(page).locator('[data-export-phase]').getAttribute('data-export-phase')
export const videoExportButton = (page: Page) => videoDialog(page).locator('[data-export-start]')

/** A one-second clip at 720p. */
export const shortVideoClip = async (page: Page) => {
    const dialog = videoDialog(page)
    await dialog.getByRole('combobox', { name: 'Resolution' }).selectOption({ label: '720p' })
    for (const [name, value] of [
        ['In', '0'],
        ['Out', '1'],
    ]) {
        const field = dialog.getByRole('textbox', { name, exact: true })
        await field.fill(value!)
        await field.press('Enter')
    }
    await expect(dialog.locator('[data-export-summary]')).toContainText('00:01.000')
}
