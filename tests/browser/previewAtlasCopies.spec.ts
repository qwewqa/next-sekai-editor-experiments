import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'
import { resource } from './previewResourceFixture'

const open = async (page: Page) => {
    await page.route('**/resource/skin.scp*', (route) => route.fulfill({ body: resource('skins') }))
    await page.route('**/resource/particle.scp*', (route) =>
        route.fulfill({ body: resource('particles') }),
    )
    await page.addInitScript(installCanvasCounters)
    await page.addInitScript(() => {
        localStorage.setItem('sonolus-next-sekai-editor.showPreview', 'false')
        Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })
        window.previewTest = {
            uploads: 0,
            frames: 0,
            bitmaps: 0,
            closes: 0,
            vertices: [],
            resolutions: 0,
            aspect: 0,
            errors: [],
        }
        const clear = WebGL2RenderingContext.prototype.clear
        WebGL2RenderingContext.prototype.clear = function (...args) {
            if (
                this.canvas instanceof HTMLCanvasElement &&
                this.canvas.matches('.preview-viewport > canvas:not(.preview-selection)')
            )
                window.previewTest.frames++
            return clear.apply(this, args)
        }
        const decode = window.createImageBitmap
        window.createImageBitmap = (async (...args: unknown[]) => {
            const options = args[1] as ImageBitmapOptions | undefined
            if (args[0] instanceof Blob && options?.premultiplyAlpha === 'premultiply')
                window.previewTest.bitmaps++
            return (await Reflect.apply(decode, window, args)) as ImageBitmap
        }) as typeof createImageBitmap
        window.addEventListener('error', (event) => window.previewTest.errors.push(event.message))
    })
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    await expect(page.locator('.preview-viewport')).toHaveCount(0)
}

const copyAndClose = (page: Page) =>
    page.evaluate(async () => {
        const { copyPreviewAtlases } = await window.editorTest.appImport<
            typeof import('../../src/preview/copyPreviewAtlases')
        >('/src/preview/copyPreviewAtlases.ts')
        const result = await copyPreviewAtlases(new AbortController().signal)
        if (result.status !== 'copied') return { status: result.status }
        const { assetSession } = await window.editorTest.appImport<
            typeof import('../../src/preview/assets')
        >('/src/preview/assets/index.ts')
        const canvas = new OffscreenCanvas(1, 1)
        const context = canvas.getContext('2d')!
        const read = (bitmap: ImageBitmap) => {
            context.clearRect(0, 0, 1, 1)
            context.drawImage(bitmap, 0, 0)
            return [...context.getImageData(0, 0, 1, 1).data]
        }
        try {
            return {
                status: result.status,
                skin: {
                    title: result.skin.title,
                    width: result.skin.texture.width,
                    pixels: read(result.skin.texture),
                    interpolation: result.skin.interpolation,
                    metadataMatches:
                        JSON.stringify(result.skin.skin) ===
                        JSON.stringify(assetSession.slots.skin.value.value?.skin),
                    independent:
                        result.skin.texture !== assetSession.slots.skin.value.value?.texture,
                },
                particle: result.particle && {
                    width: result.particle.texture.width,
                    pixels: read(result.particle.texture),
                },
            }
        } finally {
            result.skin.texture.close()
            result.particle?.texture.close()
        }
    })

const showPreview = async (page: Page) => {
    const frames = await page.evaluate(() => {
        const { settings, show, fixtures, view } = window.editorTest
        show(fixtures.notes)
        view.cursorTime = 1
        settings.showPreview = true
        return window.previewTest.frames
    })
    await expect.poll(() => page.evaluate(() => window.previewTest.frames)).toBeGreaterThan(frames)
}

test.afterEach(async ({ page }) => {
    expect(await page.evaluate(() => window.previewTest.errors)).toEqual([])
})

test('copies made during playback can be closed while the preview keeps drawing', async ({
    page,
}) => {
    await open(page)
    await showPreview(page)
    await expect.poll(() => page.evaluate(() => window.previewTest.bitmaps)).toBe(2)
    await page.evaluate(async () => {
        const { startOrStopPlayer } =
            await window.editorTest.appImport<typeof import('../../src/editor/player')>(
                '/src/editor/player.ts',
            )
        startOrStopPlayer()
    })
    expect(await copyAndClose(page)).toEqual({
        status: 'copied',
        skin: {
            title: 'Fixture',
            width: 1,
            pixels: [255, 255, 255, 255],
            interpolation: true,
            metadataMatches: true,
            independent: true,
        },
        particle: { width: 1, pixels: [255, 255, 255, 255] },
    })
    const frames = await page.evaluate(() => window.previewTest.frames)
    await expect.poll(() => page.evaluate(() => window.previewTest.frames)).toBeGreaterThan(frames)
    expect(await copyAndClose(page)).toMatchObject({ status: 'copied', skin: { width: 1 } })
    expect(
        await page.evaluate(async () => {
            const { isPlaying } =
                await window.editorTest.appImport<typeof import('../../src/player')>(
                    '/src/player.ts',
                )
            return isPlaying.value
        }),
    ).toBe(true)
    expect(await page.evaluate(() => window.previewTest.bitmaps)).toBe(2)
})

test('copies load through the session when the preview has stayed closed', async ({ page }) => {
    await open(page)
    expect(await page.evaluate(() => window.previewTest.bitmaps)).toBe(0)
    expect(await copyAndClose(page)).toMatchObject({ status: 'copied', skin: { width: 1 } })
    await expect(page.locator('.preview-viewport')).toHaveCount(0)
    await showPreview(page)
    expect(await page.evaluate(() => window.previewTest.bitmaps)).toBe(2)
    await page.evaluate(() => (window.editorTest.settings.showPreview = false))
    await expect(page.locator('.preview-viewport')).toHaveCount(0)
    expect(await copyAndClose(page)).toMatchObject({ status: 'copied', skin: { width: 1 } })
    await showPreview(page)
    expect(await page.evaluate(() => window.previewTest.bitmaps)).toBe(2)
})

test('a failed skin load returns failed and the normal retry permits copying', async ({ page }) => {
    await open(page)
    await page.route(/\/(resource|builtin)\/skin\.scp/, (route) => route.fulfill({ status: 404 }))
    expect(await copyAndClose(page)).toEqual({ status: 'failed' })
    await page.unroute(/\/(resource|builtin)\/skin\.scp/)
    await page.evaluate(async () => {
        const { reloadPreviewResources } = await window.editorTest.appImport<
            typeof import('../../src/preview/usePreviewResources')
        >('/src/preview/usePreviewResources.ts')
        reloadPreviewResources()
    })
    expect(await copyAndClose(page)).toMatchObject({ status: 'copied', skin: { title: 'Fixture' } })
})

test('copies use the shown fallback when particles fail to load', async ({ page }) => {
    await open(page)
    await page.route('**/resource/skin.scp*', (route) => route.fulfill({ status: 404 }))
    await page.route('**/builtin/skin.scp*', (route) =>
        route.fulfill({ body: resource('skins', { title: 'Fallback' }) }),
    )
    await page.route(/\/(resource|builtin)\/particle\.scp/, (route) =>
        route.fulfill({ status: 404 }),
    )
    expect(await copyAndClose(page)).toMatchObject({
        status: 'copied',
        skin: { title: 'Fallback', metadataMatches: true },
        particle: undefined,
    })
    await showPreview(page)
})

test('cancelling while loading leaves the shared load available to the preview', async ({
    page,
}) => {
    await open(page)
    expect(
        await page.evaluate(async () => {
            const { copyPreviewAtlases } = await window.editorTest.appImport<
                typeof import('../../src/preview/copyPreviewAtlases')
            >('/src/preview/copyPreviewAtlases.ts')
            const controller = new AbortController()
            const pending = copyPreviewAtlases(controller.signal)
            controller.abort()
            return (await pending).status
        }),
    ).toBe('cancelled')
    expect(await copyAndClose(page)).toMatchObject({ status: 'copied' })
    await showPreview(page)
    expect(await page.evaluate(() => window.previewTest.bitmaps)).toBe(2)
})

test('cancelling one copy request leaves a concurrent request and the preview usable', async ({
    page,
}) => {
    await open(page)
    await showPreview(page)
    expect(
        await page.evaluate(async () => {
            const { copyPreviewAtlases } = await window.editorTest.appImport<
                typeof import('../../src/preview/copyPreviewAtlases')
            >('/src/preview/copyPreviewAtlases.ts')
            const controller = new AbortController()
            const cancelled = copyPreviewAtlases(controller.signal)
            const kept = copyPreviewAtlases(new AbortController().signal)
            controller.abort()
            const [first, second] = await Promise.all([cancelled, kept])
            if (second.status === 'copied') {
                second.skin.texture.close()
                second.particle?.texture.close()
            }
            return [first.status, second.status]
        }),
    ).toEqual(['cancelled', 'copied'])
    expect(await copyAndClose(page)).toMatchObject({ status: 'copied' })
    await showPreview(page)
    expect(await page.evaluate(() => window.previewTest.bitmaps)).toBe(2)
})

test('cancelling closes copies made after cancellation', async ({ page }) => {
    await open(page)
    expect(await copyAndClose(page)).toMatchObject({ status: 'copied' })
    expect(
        await page.evaluate(async () => {
            const { copyPreviewAtlases } = await window.editorTest.appImport<
                typeof import('../../src/preview/copyPreviewAtlases')
            >('/src/preview/copyPreviewAtlases.ts')
            const original = window.createImageBitmap
            const originalClose = ImageBitmap.prototype.close
            const copies: ImageBitmap[] = []
            let onClosed!: () => void
            const closed = new Promise<void>((resolve) => (onClosed = resolve))
            ImageBitmap.prototype.close = function () {
                originalClose.call(this)
                if (copies.length === 2 && copies.every((bitmap) => !bitmap.width)) onClosed()
            }
            let release!: () => void
            const held = new Promise<void>((resolve) => (release = resolve))
            let ready!: () => void
            const started = new Promise<void>((resolve) => (ready = resolve))
            window.createImageBitmap = (async (...args: unknown[]) => {
                const bitmap = (await Reflect.apply(original, window, args)) as ImageBitmap
                copies.push(bitmap)
                if (copies.length === 2) ready()
                await held
                return bitmap
            }) as typeof createImageBitmap
            try {
                const controller = new AbortController()
                const pending = copyPreviewAtlases(controller.signal)
                await started
                controller.abort()
                const result = await pending
                release()
                await closed
                return { status: result.status, widths: copies.map((bitmap) => bitmap.width) }
            } finally {
                release()
                window.createImageBitmap = original
                ImageBitmap.prototype.close = originalClose
            }
        }),
    ).toEqual({ status: 'cancelled', widths: [0, 0] })
    expect(await copyAndClose(page)).toMatchObject({ status: 'copied' })
})

test('an asset load that never finishes reaches the copy deadline', async ({ page }) => {
    await open(page)
    await page.route('**/resource/skin.scp*', () => {})
    await page.clock.install()
    const requested = page.waitForRequest('**/resource/skin.scp*')
    const result = page.evaluate(async () => {
        const { copyPreviewAtlases } = await window.editorTest.appImport<
            typeof import('../../src/preview/copyPreviewAtlases')
        >('/src/preview/copyPreviewAtlases.ts')
        return (await copyPreviewAtlases(new AbortController().signal)).status
    })
    await requested
    await page.clock.fastForward(30_001)
    expect(await result).toBe('failed')
})
