import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'
import { resource } from './previewResourceFixture'

declare global {
    interface Window {
        atlasCopyTest: {
            holdFrames: boolean
            frameHeld: boolean
            holdReturn: boolean
            returnHeld: boolean
            releaseReturn: () => void
            statuses: (string | undefined)[]
            results?: Promise<string[]>
        }
    }
}

/** These tests set the worker host themselves, so the worker project would only repeat them. */
const controlWorker = (page: Page, testInfo: TestInfo) => {
    test.skip(testInfo.project.name === 'chromium-worker', 'The test sets the host itself')
    return page.addInitScript(() => {
        localStorage.setItem('nse.test.previewHost', 'worker')
        window.atlasCopyTest = {
            holdFrames: false,
            frameHeld: false,
            holdReturn: false,
            returnHeld: false,
            releaseReturn: () => {},
            statuses: [],
        }
        const post = Worker.prototype.postMessage
        Worker.prototype.postMessage = function (...args: unknown[]) {
            const { type } = args[0] as { type?: string }
            const control = window.atlasCopyTest
            if (type === 'frame' && control.holdFrames) {
                control.frameHeld = true
                return
            }
            if (type === 'return' && control.holdReturn) {
                control.returnHeld = true
                control.releaseReturn = () => Reflect.apply(post, this, args) as void
                return
            }
            return Reflect.apply(post, this, args) as void
        }
    })
}

const requestDuringTransition = (page: Page) =>
    page.evaluate(async () => {
        const { copyPreviewAtlases } = await window.editorTest.appImport<
            typeof import('../../src/preview/copyPreviewAtlases')
        >('/src/preview/copyPreviewAtlases.ts')
        const cancelled = new AbortController()
        const requests = [new AbortController(), new AbortController(), cancelled].map(
            async (controller, index) => {
                const result = await copyPreviewAtlases(controller.signal)
                if (result.status === 'copied') {
                    result.skin.texture.close()
                    result.particle?.texture.close()
                }
                window.atlasCopyTest.statuses[index] = result.status
                return result.status
            },
        )
        window.atlasCopyTest.results = Promise.all(requests)
        cancelled.abort()
        await requests[2]
    })

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
            if (
                args[0] instanceof Blob &&
                options?.premultiplyAlpha === 'premultiply' &&
                options.colorSpaceConversion === 'none'
            )
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

test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.status === 'skipped') return
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

test('an asset load slower than 30 seconds is waited for, and copies once it finishes', async ({
    page,
}) => {
    await open(page)
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    await page.route('**/resource/skin.scp*', async (route) => {
        await held
        await route.fulfill({ body: resource('skins') })
    })
    await page.clock.install()
    const requested = page.waitForRequest('**/resource/skin.scp*')
    await page.evaluate(async () => {
        const { copyPreviewAtlases } = await window.editorTest.appImport<
            typeof import('../../src/preview/copyPreviewAtlases')
        >('/src/preview/copyPreviewAtlases.ts')
        Reflect.set(window, 'slowCopy', 'pending')
        void copyPreviewAtlases(new AbortController().signal).then((result) => {
            Reflect.set(window, 'slowCopy', result.status)
            if (result.status === 'copied') {
                result.skin.texture.close()
                result.particle?.texture.close()
            }
        })
    })
    await requested
    await page.clock.fastForward(60_001)
    expect(await page.evaluate(() => Reflect.get(window, 'slowCopy'))).toBe('pending')
    release()
    await expect.poll(() => page.evaluate(() => Reflect.get(window, 'slowCopy'))).toBe('copied')
})

test('copies wait for held recovery loads after a worker timeout', async ({ page }, testInfo) => {
    await controlWorker(page, testInfo)
    await open(page)
    await showPreview(page)
    await page.evaluate(() => window.nsePreviewTest!.settled())
    await page.clock.install()
    let releaseSkin!: () => void
    let releaseParticle!: () => void
    const skinHeld = new Promise<void>((resolve) => (releaseSkin = resolve))
    const particleHeld = new Promise<void>((resolve) => (releaseParticle = resolve))
    let loads = 0
    await page.route(/\/resource\/(skin|particle)\.scp/, async (route) => {
        loads++
        const skin = route.request().url().includes('/skin.')
        await (skin ? skinHeld : particleHeld)
        await route.fulfill({
            body: resource(skin ? 'skins' : 'particles', { title: 'Recovered' }),
        })
    })
    try {
        await page.evaluate(() => {
            window.atlasCopyTest.holdFrames = true
            window.editorTest.view.cursorTime = 2
        })
        await expect.poll(() => page.evaluate(() => window.atlasCopyTest.frameHeld)).toBe(true)
        await page.clock.fastForward(10_001)
        await expect.poll(() => loads).toBe(2)
        await requestDuringTransition(page)
        expect(
            await page.evaluate(() =>
                [0, 1, 2].map((i) => window.atlasCopyTest.statuses[i] ?? 'pending'),
            ),
        ).toEqual(['pending', 'pending', 'cancelled'])
        releaseSkin()
        await expect
            .poll(() =>
                page.evaluate(async () => {
                    const { assetSession } = await window.editorTest.appImport<
                        typeof import('../../src/preview/assets')
                    >('/src/preview/assets/index.ts')
                    return assetSession.slots.skin.value.value?.title
                }),
            )
            .toBe('Recovered')
        releaseParticle()
        expect(await page.evaluate(() => window.atlasCopyTest.results)).toEqual([
            'copied',
            'copied',
            'cancelled',
        ])
        expect(await copyAndClose(page)).toMatchObject({ status: 'copied' })
    } finally {
        releaseSkin()
        releaseParticle()
    }
})

test('copies wait while the worker hands its atlases back', async ({ page }, testInfo) => {
    await controlWorker(page, testInfo)
    await open(page)
    await showPreview(page)
    await page.evaluate(async () => {
        const { previewWorker } = await window.editorTest.appImport<
            typeof import('../../src/preview/worker/host')
        >('/src/preview/worker/host.ts')
        window.atlasCopyTest.holdReturn = true
        void previewWorker().stop()
    })
    await expect.poll(() => page.evaluate(() => window.atlasCopyTest.returnHeld)).toBe(true)
    await requestDuringTransition(page)
    await page.evaluate(() => window.atlasCopyTest.releaseReturn())
    expect(await page.evaluate(() => window.atlasCopyTest.results)).toEqual([
        'copied',
        'copied',
        'cancelled',
    ])
    expect(await copyAndClose(page)).toMatchObject({ status: 'copied' })
})

test('copying restarts after a skin change and closes partial copies', async ({ page }) => {
    await open(page)
    expect(await copyAndClose(page)).toMatchObject({ status: 'copied' })
    await page.route('**/builtin/skin.scp*', (route) =>
        route.fulfill({ body: resource('skins', { title: 'Replacement' }) }),
    )
    expect(
        await page.evaluate(async () => {
            const { copyPreviewAtlases } = await window.editorTest.appImport<
                typeof import('../../src/preview/copyPreviewAtlases')
            >('/src/preview/copyPreviewAtlases.ts')
            const { assetSession } = await window.editorTest.appImport<
                typeof import('../../src/preview/assets')
            >('/src/preview/assets/index.ts')
            const { watch } =
                await window.editorTest.appImport<typeof import('../helpers/vue')>(
                    '/tests/helpers/vue.ts',
                )
            const original = window.createImageBitmap
            const skin = assetSession.slots.skin.value.value!
            const particle = assetSession.slots.particle.value.value!
            const partial: ImageBitmap[] = []
            let release!: () => void
            const held = new Promise<void>((resolve) => (release = resolve))
            let ready!: () => void
            const started = new Promise<void>((resolve) => (ready = resolve))
            window.createImageBitmap = (async (...args: unknown[]) => {
                if (args[0] === skin.texture) await held
                const bitmap = (await Reflect.apply(original, window, args)) as ImageBitmap
                if (args[0] === particle.texture && !partial.length) {
                    partial.push(bitmap)
                    ready()
                }
                return bitmap
            }) as typeof createImageBitmap
            try {
                const pending = copyPreviewAtlases(new AbortController().signal)
                await started
                const changed = new Promise<void>((resolve) => {
                    const stop = watch(assetSession.slots.skin, (slot) => {
                        if (slot.value === skin) return
                        stop()
                        resolve()
                    })
                })
                const { settings } = window.editorTest
                settings.previewAssets = { ...settings.previewAssets, skin: { source: 'builtin' } }
                await changed
                release()
                const result = await pending
                if (result.status === 'copied') {
                    result.skin.texture.close()
                    result.particle?.texture.close()
                }
                return {
                    status: result.status,
                    title: result.status === 'copied' ? result.skin.title : undefined,
                    partialWidths: partial.map((bitmap) => bitmap.width),
                }
            } finally {
                release()
                window.createImageBitmap = original
            }
        }),
    ).toEqual({ status: 'copied', title: 'Replacement', partialWidths: [0] })
})
