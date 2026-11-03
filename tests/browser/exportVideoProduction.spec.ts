import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import type { ExportFaults } from '../../src/exportVideo/protocol'
import { installEditorFixture, installTestPlatform } from './editorFixture'
import {
    openVideoDialog,
    shortVideoClip,
    videoExportButton,
    videoExportTimeout,
    videoPhase,
} from './exportVideoDialog'
import { resource } from './previewResourceFixture'
import { refusingPicker, refusingPicks } from './saveFlows'

for (const route of ['staged', 'memory', 'memory without worker sync access'])
    test(`the ${route} route downloads a WebM file that can be read and decoded`, async ({
        page,
    }, testInfo) => {
        test.slow()
        await page.addInitScript(() => {
            Reflect.deleteProperty(window, 'showSaveFilePicker')
        })
        await page.route('**/resource/skin.scp*', (route) =>
            route.fulfill({ body: resource('skins') }),
        )
        await page.route('**/resource/particle.scp*', (route) =>
            route.fulfill({ body: resource('particles') }),
        )
        await page.goto('/')
        await page.evaluate(installEditorFixture)
        await page.evaluate(() => window.editorTest.show(window.editorTest.fixtures.notes))
        if (route === 'memory')
            await page.evaluate(async () => {
                const { platform } =
                    await window.editorTest.appImport<typeof import('../../src/platform')>(
                        '/src/platform/index.ts',
                    )
                platform.videoOutput!.stage = () =>
                    Promise.reject(new DOMException('Staging unavailable', 'NotSupportedError'))
            })
        // The page can stage the file, but the worker cannot open it, so it writes to memory.
        const faults = route === 'staged' || route === 'memory' ? undefined : { noSyncAccess: true }
        const dialog = await openVideoDialog(page, { production: true, faults })
        await shortVideoClip(page)
        await dialog.locator('[data-export-advanced]').click()
        await dialog.getByRole('combobox', { name: 'Format', exact: true }).selectOption('webm')
        await expect(videoExportButton(page)).toBeEnabled({ timeout: videoExportTimeout })
        await videoExportButton(page).click()
        await expect.poll(() => videoPhase(page), { timeout: videoExportTimeout }).toBe('ready')
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
        expect(media.frames).toBe(6)
        expect(media.width).toBe(1280)
        expect(media.height).toBe(720)
        expect(media.firstVideo).toBe(0)
        expect(media.videoEnd).toBeCloseTo(0.2, 3)
        expect(media.firstAudio).toBeLessThanOrEqual(0.001)
        await dialog.locator('[data-export-close]').click()
        await expect(dialog).toHaveCount(0)
    })

/** The page with a save picker whose file the page may not read, and the worker's refusal. */
const refusingVideoPage = async (page: Page, refuse: NonNullable<ExportFaults['refuse']>) => {
    // The user renames the file in the picker.
    await refusingPicker(page, { read: 'always', as: 'renamed.webm' })
    // The press keeps its activation: the picker opens without a Ready press.
    await page.addInitScript(installTestPlatform, { activation: true })
    await page.route('**/resource/skin.scp*', (route) => route.fulfill({ body: resource('skins') }))
    await page.route('**/resource/particle.scp*', (route) =>
        route.fulfill({ body: resource('particles') }),
    )
    await page.goto('/')
    await page.evaluate(installEditorFixture)
    await page.evaluate(() => window.editorTest.show(window.editorTest.fixtures.notes))
    const dialog = await openVideoDialog(page, { production: true, faults: { refuse } })
    await shortVideoClip(page)
    await dialog.locator('[data-export-advanced]').click()
    await dialog.getByRole('combobox', { name: 'Format', exact: true }).selectOption('webm')
    await expect(videoExportButton(page)).toBeEnabled({ timeout: videoExportTimeout })
    await videoExportButton(page).click()
    return dialog
}

const framesOf = (page: Page, bytes: Uint8Array) =>
    page.evaluate(
        async (bytes) => {
            const { readVideo } = await import('/tests/helpers/readVideo.ts')
            return (await readVideo(bytes)).frames
        },
        [...bytes],
    )

test('a picked file refusing reads receives the whole video', async ({ page }) => {
    test.slow()
    await refusingVideoPage(page, 'read')
    await expect.poll(() => videoPhase(page), { timeout: videoExportTimeout }).toBe('done')
    const [name] = await refusingPicks(page)
    const bytes = await page.evaluate(async (name) => {
        const root = await navigator.storage.getDirectory()
        const file = await (await root.getFileHandle(name)).getFile()
        return [...new Uint8Array(await file.arrayBuffer())]
    }, name!)
    expect(await framesOf(page, new Uint8Array(bytes))).toBe(6)
})

for (const refuse of ['open', 'write', 'close'] as const)
    test(`a picked file refusing ${refuse} is exported again, staged, and downloads whole from Ready`, async ({
        page,
    }, testInfo) => {
        test.slow()
        const dialog = await refusingVideoPage(page, refuse)
        await expect.poll(() => videoPhase(page), { timeout: videoExportTimeout }).toBe('ready')
        const downloading = page.waitForEvent('download')
        await dialog.locator('[data-export-download]').click()
        const download = await downloading
        // The name given in the picker.
        expect(download.suggestedFilename()).toBe('renamed.webm')
        const path = testInfo.outputPath('export.webm')
        await download.saveAs(path)
        expect(await framesOf(page, await readFile(path))).toBe(6)
    })
