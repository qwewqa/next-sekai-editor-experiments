import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { installEditorFixture } from './editorFixture'
import { openVideoDialog, videoDialog, videoExportButton, videoPhase } from './exportVideoDialog'
import { wav } from './levelInfoFiles'
import { resource } from './previewResourceFixture'

// Firefox has no save picker, so the file is staged in OPFS and the Ready state's Download
// delivers it. It makes WebM. Firefox is slower than Chromium, so the clip is three seconds.
const seconds = 3
const frameRate = 30

test.skip(({ browserName }) => browserName !== 'firefox', 'Firefox behaviour')

test.beforeEach(async ({ page }) => {
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
})

/** Decodes a WAV file as the editor does for a BGM and makes it the chart's BGM. */
const setBgm = (page: Page, bytes: number[]) =>
    page.evaluate(async (bytes) => {
        const { decodeBgmData } = await window.editorTest.appImport<
            typeof import('../../src/editor/media/heldBgm')
        >('/src/editor/media/heldBgm.ts')
        const decoded = await decodeBgmData(new Uint8Array(bytes).buffer)
        const { history } = window.editorTest
        history.replaceState({ ...history.state.value, bgm: { offset: 0, ...decoded } })
    }, bytes)

const openClip = async (page: Page) => {
    const dialog = await openVideoDialog(page, { production: true })
    await dialog.getByRole('combobox', { name: 'Resolution' }).selectOption({ label: '720p' })
    for (const [name, value] of [
        ['In', '0'],
        ['Out', String(seconds)],
    ]) {
        const field = dialog.getByRole('textbox', { name, exact: true })
        await field.fill(value!)
        await field.press('Enter')
    }
    await expect(dialog.locator('[data-export-summary]')).toContainText('00:03.000')
    await dialog.locator('[data-export-advanced]').click()
    await dialog.getByRole('combobox', { name: 'Format', exact: true }).selectOption('webm')
    return dialog
}

const finish = async (page: Page, testInfo: TestInfo) => {
    const dialog = videoDialog(page)
    await expect(videoExportButton(page)).toBeEnabled()
    await videoExportButton(page).click()
    await expect.poll(() => videoPhase(page), { timeout: 150_000 }).toBe('ready')
    const downloading = page.waitForEvent('download')
    await dialog.locator('[data-export-download]').click()
    const download = await downloading
    expect(download.suggestedFilename()).toMatch(/\.webm$/)
    const path = testInfo.outputPath('export.webm')
    await download.saveAs(path)
    const bytes = await readFile(path)
    // The download comes from the staged file, not a fallback held in memory.
    const staged = await page.evaluate(async () => {
        const directory = await (
            await navigator.storage.getDirectory()
        ).getDirectoryHandle('export-video')
        const sizes: number[] = []
        for await (const [name, handle] of directory.entries())
            if (name.endsWith('.webm') && handle.kind === 'file')
                sizes.push((await (handle as FileSystemFileHandle).getFile()).size)
        return sizes
    })
    expect(staged).toEqual([bytes.length])
    const media = await page.evaluate(
        async (bytes) => {
            const { readTracks } = await import('/tests/helpers/readVideo.ts')
            return readTracks(bytes)
        },
        [...bytes],
    )
    await dialog.locator('[data-export-close]').click()
    await expect(dialog).toHaveCount(0)
    return media
}

type Media = Awaited<ReturnType<typeof finish>>

const expectVideo = (media: Media) => {
    expect(media.format).toBe('WebM')
    expect(media.videoCodec).toBe('vp9')
    expect(media.width).toBe(1280)
    expect(media.height).toBe(720)
    expect(media.frames).toBe(seconds * frameRate)
    expect(media.firstVideo).toBe(0)
    expect(media.videoEnd).toBeCloseTo(seconds, 3)
}

const expectAudio = (media: Media) => {
    expect(media.trackCount).toBe(2)
    expect(media.audio?.codec).toBe('opus')
    expect(media.audio?.end).toBeCloseTo(seconds, 1)
}

test.describe('Export Video on Firefox', () => {
    test.setTimeout(240_000)

    test('a chart with a BGM exports a WebM with VP9 video and Opus sound', async ({
        page,
    }, testInfo) => {
        await setBgm(page, [...wav(12)])
        const dialog = await openClip(page)
        await dialog.getByRole('switch', { name: 'SFX' }).click()
        await expect(dialog.getByRole('switch', { name: 'BGM', exact: true })).toBeChecked()
        const media = await finish(page, testInfo)
        expectVideo(media)
        expectAudio(media)
        expect(media.audio?.peak).toBeGreaterThan(0.05)
    })

    test('a chart with no BGM exports its sound effects as the audio track', async ({
        page,
    }, testInfo) => {
        const dialog = await openClip(page)
        const bgm = dialog.getByRole('switch', { name: 'BGM', exact: true })
        await expect(bgm).toBeDisabled()
        await expect(bgm).not.toBeChecked()
        await expect(dialog.getByRole('switch', { name: 'SFX' })).toBeChecked()
        const media = await finish(page, testInfo)
        expectVideo(media)
        expectAudio(media)
        expect(media.audio?.peak).toBeGreaterThan(0.01)
    })

    test('a chart whose BGM is a silent file exports a silent audio track', async ({
        page,
    }, testInfo) => {
        const silent = wav(12)
        silent.fill(0, 44)
        await setBgm(page, [...silent])
        const dialog = await openClip(page)
        await dialog.getByRole('switch', { name: 'SFX' }).click()
        await expect(dialog.getByRole('switch', { name: 'BGM', exact: true })).toBeChecked()
        const media = await finish(page, testInfo)
        expectVideo(media)
        expectAudio(media)
        expect(media.audio?.peak).toBeLessThan(1e-4)
    })

    test('no BGM and SFX off exports a video with no audio track', async ({ page }, testInfo) => {
        const dialog = await openClip(page)
        await expect(dialog.getByRole('switch', { name: 'BGM', exact: true })).toBeDisabled()
        await dialog.getByRole('switch', { name: 'SFX' }).click()
        await expect(dialog.getByRole('switch', { name: 'SFX' })).not.toBeChecked()
        const media = await finish(page, testInfo)
        expectVideo(media)
        expect(media.trackCount).toBe(1)
        expect(media.audio).toBeUndefined()
    })
})
