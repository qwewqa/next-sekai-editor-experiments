import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'

// A failed loading task names the failure in the UI locale; the browser's English text is only in
// the Error Details disclosure.

const openUtility = async (page: Page, name: 'coverEditor' | 'previewEditor') => {
    await page.evaluate(async (name) => {
        const { showModal } = await import('/src/modals/index.ts')
        const { default: component } =
            name === 'coverEditor'
                ? await import('/src/editor/utilities/coverEditor/CoverEditorModal.vue')
                : await import('/src/editor/utilities/previewEditor/PreviewEditorModal.vue')
        void showModal(component, {})
    }, name)
    await expect(page.getByRole('dialog')).toHaveCount(1)
}

const chooseFile = async (page: Page, name: string, mimeType: string, buffer: Buffer) => {
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('dialog').first().locator('input[type="button"]').click()
    await (await chooser).setFiles({ name, mimeType, buffer })
}

const text = (content: string) => Buffer.from(content)

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
})

const failure = (page: Page) => page.getByRole('dialog').last()

test('a file the browser cannot decode as audio says so, with the browser text as detail', async ({
    page,
}) => {
    await openUtility(page, 'previewEditor')
    await chooseFile(page, 'notes.mp3', 'audio/mpeg', text('this is not audio'))
    const dialog = failure(page)
    await expect(dialog).toContainText('This audio file could not be read.')
    // The raw sentence is behind the disclosure.
    const details = dialog.locator('details')
    await expect(details).toHaveCount(1)
    await expect(details).not.toHaveAttribute('open', '')
    await expect(dialog.getByText('Unable to decode audio data')).toBeHidden()
    await details.locator('summary').click()
    await expect(dialog.getByText(/decode audio/i)).toBeVisible()
})

test('a file that is not an image says so in the Cover Editor', async ({ page }) => {
    await openUtility(page, 'coverEditor')
    await chooseFile(page, 'notes.png', 'image/png', text('this is not an image'))
    const dialog = failure(page)
    await expect(dialog).toContainText('This image could not be read.')
    await expect(dialog.getByText('Failed to decode cover')).toBeHidden()
})

test('the failure is worded in the interface language', async ({ page }) => {
    await page.evaluate(() => {
        window.editorTest.settings.locale = 'fr'
    })
    await openUtility(page, 'coverEditor')
    await chooseFile(page, 'notes.png', 'image/png', text('this is not an image'))
    await expect(failure(page)).toContainText('Cette image n’a pas pu être lue.')
    await expect(failure(page)).not.toContainText('Failed to decode cover')
})
