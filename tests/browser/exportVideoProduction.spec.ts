import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { installEditorFixture } from './editorFixture'
import { openVideoDialog, shortVideoClip, videoExportButton, videoPhase } from './exportVideoDialog'
import { resource } from './previewResourceFixture'

test('the page dialog exports a WebM file that can be read and decoded', async ({
    page,
}, testInfo) => {
    test.setTimeout(60_000)
    await page.addInitScript(() => {
        Reflect.deleteProperty(window, 'showSaveFilePicker')
    })
    await page.route('**/resource/skin.scp*', (route) => route.fulfill({ body: resource('skins') }))
    await page.route('**/resource/particle.scp*', (route) =>
        route.fulfill({ body: resource('particles') }),
    )
    await page.goto('/')
    await page.evaluate(installEditorFixture)
    await page.evaluate(() => window.editorTest.show(window.editorTest.fixtures.notes))
    const dialog = await openVideoDialog(page, { production: true })
    await shortVideoClip(page)
    await dialog.locator('[data-export-advanced]').click()
    await dialog.getByRole('combobox', { name: 'Format', exact: true }).selectOption('webm')
    await expect(videoExportButton(page)).toBeEnabled()
    await videoExportButton(page).click()
    await expect.poll(() => videoPhase(page), { timeout: 20_000 }).toBe('ready')
    const downloading = page.waitForEvent('download')
    await dialog.locator('[data-export-download]').click()
    const download = await downloading
    expect(download.suggestedFilename()).toMatch(/\.webm$/)
    const path = testInfo.outputPath('export.webm')
    await download.saveAs(path)
    const bytes = await readFile(path)
    const media = await page.evaluate(
        async (bytes) => {
            const { readVideo } = await import('/tests/helpers/readVideo.ts')
            return readVideo(bytes)
        },
        [...bytes],
    )
    expect(media.frames).toBe(30)
    expect(media.width).toBe(1280)
    expect(media.height).toBe(720)
    expect(media.firstVideo).toBe(0)
    expect(media.videoEnd).toBeCloseTo(1, 3)
    expect(media.firstAudio).toBeLessThanOrEqual(0.001)
    await dialog.locator('[data-export-close]').click()
    await expect(dialog).toHaveCount(0)
})
