import { expect, test, type Page } from '@playwright/test'
import { gzipSync } from 'node:zlib'
import { installTextureAccount, type TextureAccount } from '../../src/preview/textureAccount'
import { installCanvasCounters, installEditorFixture } from './editorFixture'
import { openVideoDialog, videoDialog } from './exportVideoDialog'
import { patched } from './previewAssetsPackages'
import { resource } from './previewResourceFixture'

// The preview frees its atlas textures while Export Video is open and uploads them again when it
// closes, in either host.

declare global {
    interface Window {
        textureAccount: TextureAccount
    }
}

type Boot = {
    /** The Built-in skin, particle and background, the background blurred. */
    builtin?: boolean
    /** The particle package arrives only when the returned function is called. */
    holdParticle?: boolean
}

const boot = async (page: Page, { builtin = false, holdParticle = false }: Boot = {}) => {
    let releaseParticle = () => undefined as void
    const particleHeld = new Promise<void>((resolve) => {
        releaseParticle = resolve
    })
    if (builtin) {
        const background = await patched('background', {
            resources: {
                configuration: new Uint8Array(
                    gzipSync(JSON.stringify({ blur: 6, mask: '#00000000' })),
                ),
            },
        })
        await page.route('**/builtin/background.scp*', (route) =>
            route.fulfill({ body: Buffer.from(background) }),
        )
        await page.route('**/builtin/particle.scp*', async (route) => {
            if (holdParticle) await particleHeld
            await route.continue()
        })
        await page.addInitScript(() => {
            localStorage.setItem(
                'sonolus-next-sekai-editor.previewAssets',
                JSON.stringify(
                    Object.fromEntries(
                        ['skin', 'particle', 'background', 'effect'].map((type) => [
                            type,
                            { source: 'builtin' },
                        ]),
                    ),
                ),
            )
        })
    } else {
        await page.route('**/resource/skin.scp*', (route) =>
            route.fulfill({ body: resource('skins') }),
        )
        await page.route('**/resource/particle.scp*', async (route) => {
            if (holdParticle) await particleHeld
            await route.fulfill({ body: resource('particles') })
        })
    }
    await page.addInitScript(installCanvasCounters)
    await page.addInitScript(() => {
        window.previewTest = {
            uploads: 0,
            frames: 0,
            bitmaps: 0,
            closes: 0,
            vertices: [],
            backgroundVertices: [],
            resolutions: 0,
            aspect: 0,
            errors: [],
        }
        window.addEventListener('error', (event) => window.previewTest.errors.push(event.message))
        const isPreview = (gl: WebGL2RenderingContext) =>
            gl.canvas instanceof HTMLCanvasElement &&
            gl.canvas.matches('.preview-viewport > canvas:not(.preview-selection)')
        const prototype = WebGL2RenderingContext.prototype
        const upload = prototype.texImage2D
        prototype.texImage2D = function (...args: unknown[]) {
            if (
                isPreview(this) &&
                this.getParameter(this.ACTIVE_TEXTURE) !== this.TEXTURE3 &&
                args.some((arg) => arg instanceof ImageBitmap)
            )
                window.previewTest.uploads++
            return Reflect.apply(upload, this, args)
        }
        const uniformNames = new WeakMap<WebGLUniformLocation, string>()
        const getUniformLocation = prototype.getUniformLocation
        prototype.getUniformLocation = function (program, name) {
            const location = getUniformLocation.call(this, program, name)
            if (location) uniformNames.set(location, name)
            return location
        }
        const uniform1f = prototype.uniform1f
        prototype.uniform1f = function (location, value) {
            if (isPreview(this) && location && uniformNames.get(location) === 'u_aspect')
                window.previewTest.aspect = value
            return uniform1f.call(this, location, value)
        }
        const storage = prototype.texStorage2D
        prototype.texStorage2D = function (...args) {
            if (isPreview(this))
                window.previewTest.allocations = (window.previewTest.allocations ?? 0) + 1
            return storage.apply(this, args)
        }
        const clear = prototype.clear
        prototype.clear = function (...args) {
            if (
                isPreview(this) &&
                (this.getParameter(this.COLOR_CLEAR_VALUE) as Float32Array)[3] === 0
            ) {
                window.previewTest.frames++
                window.previewTest.vertices = []
            }
            return clear.apply(this, args)
        }
        const bufferSubData = prototype.bufferSubData
        prototype.bufferSubData = function (...args: unknown[]) {
            const data = args[2]
            if (isPreview(this) && data instanceof Float32Array) {
                if (data[5] === 3) window.previewTest.backgroundVertices = [...data]
                else window.previewTest.vertices.push(...data)
            }
            return Reflect.apply(bufferSubData, this, args)
        }
    })
    await page.addInitScript({
        content: `window.textureAccount = (${installTextureAccount.toString()})((gl) =>
            gl.canvas instanceof HTMLCanvasElement &&
            gl.canvas.matches('.preview-viewport > canvas:not(.preview-selection)'))`,
    })
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    await page.evaluate(() => {
        const { settings, show, fixtures, view } = window.editorTest
        show(fixtures.notes)
        view.cursorTime = 1
        settings.showPreview = true
    })
    await expect(page.locator('.preview-viewport')).toBeVisible()
    if (!holdParticle)
        await expect.poll(() => page.evaluate(() => window.previewTest.uploads)).toBe(2)
    await expect
        .poll(() =>
            page.evaluate(async () => {
                const { assetSession } = await window.editorTest.appImport<
                    typeof import('../../src/preview/assets')
                >('/src/preview/assets/index.ts')
                return assetSession.slots.background.value.state
            }),
        )
        .toBe('ready')
    await settle(page)
    return releaseParticle
}

const settle = (page: Page) =>
    page.evaluate(async () => {
        await window.editorTest.nextTick()
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
        await window.nsePreviewTest?.settled()
    })

const host = (page: Page) => page.evaluate(() => window.nsePreviewTest?.host)

/** The latest preview worker. */
const previewWorker = (page: Page) => {
    const worker = page
        .workers()
        .filter((item) => item.url().includes('preview.worker'))
        .at(-1)
    if (!worker) throw new Error('No preview worker')
    return worker
}

/** The account of the realm that draws the preview: the page's, or the latest preview worker's. */
const account = async (page: Page) => {
    const read = () => {
        const { bytes, calls, frames } = Reflect.get(globalThis, 'textureAccount') as TextureAccount
        return {
            bytes: bytes(),
            calls: [...calls],
            frames: frames.map((frame) => ({ ...frame, slots: [...frame.slots].sort() })),
        }
    }
    if ((await host(page)) === 'main') return page.evaluate(read)
    return previewWorker(page).evaluate(read)
}
const bytes = async (page: Page) => (await account(page)).bytes
const frameCount = async (page: Page) => (await account(page)).frames.length

/** The frames drawn after the first `count`, once there is one. */
const framesAfter = async (page: Page, count: number) => {
    await expect.poll(() => frameCount(page)).toBeGreaterThan(count)
    return (await account(page)).frames.slice(count)
}

const counts = (page: Page) =>
    page.evaluate(() => ({
        uploads: window.previewTest.uploads,
        frames: window.previewTest.frames,
        allocations: window.previewTest.allocations ?? 0,
    }))

const picture = (page: Page) =>
    page.locator('.preview-viewport > canvas:not(.preview-selection)').screenshot()

const closeDialog = async (page: Page) => {
    await page.keyboard.press('Escape')
    await expect(videoDialog(page)).toHaveCount(0)
}

test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.status === 'skipped') return
    expect(await page.evaluate(() => window.previewTest.errors)).toEqual([])
})

/** The texture slots the last frame drew from, other than the background. */
const drawnSlots = (page: Page) =>
    page.evaluate(() => {
        const vertices = window.previewTest.vertices
        const slots = new Set<number>()
        for (let i = 5; i < vertices.length; i += 10) slots.add(vertices[i]!)
        return [...slots].sort()
    })

test('the atlases and the blur are freed while Export Video is open and come back when it closes', async ({
    page,
}) => {
    await boot(page, { builtin: true })
    // Notes and a hit effect.
    await page.evaluate(() => (window.editorTest.view.cursorTime = 1.2))
    await settle(page)
    const before = await account(page)
    const last = before.frames.at(-1)!
    // The skin, the particle and the background.
    expect(last.slots).toEqual([0, 1, 3])
    expect(before.bytes).toBeGreaterThan(0)
    const shown = await picture(page)
    const counted = await counts(page)

    await openVideoDialog(page)
    await expect.poll(() => bytes(page)).toBe(0)
    // The release submits its deletes at once.
    const opened = await account(page)
    const released = opened.calls.slice(before.calls.length)
    expect(released).toContain('deleteTexture')
    expect(released).toContain('deleteFramebuffer')
    expect(released.lastIndexOf('flush')).toBeGreaterThan(
        Math.max(released.lastIndexOf('deleteTexture'), released.lastIndexOf('deleteFramebuffer')),
    )
    await settle(page)
    expect(await counts(page)).toEqual(counted)
    expect(await frameCount(page)).toBe(before.frames.length)

    await closeDialog(page)
    // The first frame after closing has every atlas, at the same size.
    const [first] = await framesAfter(page, before.frames.length)
    expect(first).toEqual(last)
    await expect
        .poll(() => page.evaluate(() => window.previewTest.uploads))
        .toBe(counted.uploads + 2)
    expect(await bytes(page)).toBe(before.bytes)
    await settle(page)
    // The picture is that first frame's.
    expect((await picture(page)).equals(shown)).toBe(true)
    expect(await frameCount(page)).toBe(before.frames.length + 1)
})

const particleState = async (page: Page) =>
    page.evaluate(async () => {
        const { assetSession } = await window.editorTest.appImport<
            typeof import('../../src/preview/assets')
        >('/src/preview/assets/index.ts')
        return assetSession.slots.particle.value.state
    })

test('a particle atlas that arrives while Export Video is open draws its effects when it closes', async ({
    page,
}) => {
    const releaseParticle = await boot(page, { builtin: true, holdParticle: true })
    await expect.poll(() => page.evaluate(() => window.previewTest.uploads)).toBe(1)
    // A hit effect is due, but the particle has not arrived.
    await page.evaluate(() => (window.editorTest.view.cursorTime = 1.2))
    await settle(page)
    expect((await account(page)).frames.at(-1)!.slots).toEqual([0, 3])
    // The same moment with Show Effects on, but without the particle's pixels.
    const withoutParticle = await picture(page)
    await openVideoDialog(page)
    await expect.poll(() => bytes(page)).toBe(0)
    releaseParticle()
    await expect.poll(() => particleState(page)).toBe('ready')
    await settle(page)
    expect(await counts(page)).toMatchObject({ uploads: 1 })
    expect(await bytes(page)).toBe(0)
    const count = await frameCount(page)
    await closeDialog(page)
    const [first] = await framesAfter(page, count)
    expect(first!.slots).toEqual([0, 1, 3])
    await expect.poll(() => page.evaluate(() => window.previewTest.uploads)).toBe(3)
    await settle(page)
    // The first frame after closing shows the particle's pixels.
    expect((await picture(page)).equals(withoutParticle)).toBe(false)
    expect(await frameCount(page)).toBe(count + 1)
})

/** The preview's pixels that are pure red, from a screenshot. */
const redPixels = async (page: Page) => {
    const png = (await picture(page)).toString('base64')
    return page.evaluate(async (png) => {
        const image = new Image()
        image.src = `data:image/png;base64,${png}`
        await image.decode()
        const canvas = new OffscreenCanvas(image.width, image.height)
        const context = canvas.getContext('2d')!
        context.drawImage(image, 0, 0)
        const { data } = context.getImageData(0, 0, image.width, image.height)
        let red = 0
        for (let i = 0; i < data.length; i += 4)
            if (data[i]! > 250 && data[i + 1]! < 5 && data[i + 2]! < 5) red++
        return red
    }, png)
}

test('a skin replaced while Export Video is open is the one drawn when it closes', async ({
    page,
}) => {
    await boot(page)
    expect(await redPixels(page)).toBe(0)
    const counted = await counts(page)
    await openVideoDialog(page)
    await expect.poll(() => bytes(page)).toBe(0)
    // Every sprite of the fixture skin covers its whole atlas, so every note turns red.
    await page.evaluate(async () => {
        const { assetSession } = await window.editorTest.appImport<
            typeof import('../../src/preview/assets')
        >('/src/preview/assets/index.ts')
        const slot = assetSession.slots.skin
        const image = new OffscreenCanvas(1, 1)
        const context = image.getContext('2d')!
        context.fillStyle = '#f00'
        context.fillRect(0, 0, 1, 1)
        const texture = await createImageBitmap(image, {
            premultiplyAlpha: 'premultiply',
            colorSpaceConversion: 'none',
        })
        slot.value = { state: 'ready', value: { ...slot.value.value!, texture } }
    })
    await settle(page)
    expect(await counts(page)).toEqual(counted)
    const count = await frameCount(page)
    await closeDialog(page)
    const [first] = await framesAfter(page, count)
    expect(first!.slots).toContain(0)
    await expect
        .poll(() => page.evaluate(() => window.previewTest.uploads))
        .toBe(counted.uploads + 2)
    await settle(page)
    // The picture is the first frame's.
    expect(await redPixels(page)).toBeGreaterThan(0)
    expect(await frameCount(page)).toBe(count + 1)
})

/** Opens Export Video as the toolbar does, and keeps the opening's promise. */
const openTracked = async (page: Page) => {
    await page.evaluate(async () => {
        const { appImport } = window.editorTest
        const { openExportVideo } = await appImport<
            typeof import('../../src/editor/exportVideo/open')
        >('/src/editor/exportVideo/open.ts')
        const { pageEnv } = await appImport<typeof import('../../src/editor/exportVideo/env')>(
            '/src/editor/exportVideo/env.ts',
        )
        const env = pageEnv(
            () => new Worker('/src/editor/exportVideo/export.worker.ts', { type: 'module' }),
        )
        Reflect.set(window, 'videoOpening', openExportVideo(env))
        Reflect.set(window, 'videoEnv', env)
    })
    await expect(videoDialog(page)).toBeVisible()
}

test('closing and opening Export Video again at once leaves the atlases freed, and every frame between has them', async ({
    page,
}) => {
    await boot(page)
    const before = await account(page)
    const last = before.frames.at(-1)!
    expect(last.slots).toContain(0)
    const shown = await picture(page)
    await openTracked(page)
    await expect.poll(() => bytes(page)).toBe(0)
    // The second opening starts as soon as the first has ended, before the next animation frame.
    await page.evaluate(async () => {
        const { modals, closeModal } =
            await window.editorTest.appImport<typeof import('../../src/modals')>(
                '/src/modals/index.ts',
            )
        const { openExportVideo } = await window.editorTest.appImport<
            typeof import('../../src/editor/exportVideo/open')
        >('/src/editor/exportVideo/open.ts')
        const opening = Reflect.get(window, 'videoOpening') as Promise<void>
        closeModal(modals.at(-1)!)
        await opening
        Reflect.set(
            window,
            'videoOpening',
            openExportVideo(
                Reflect.get(window, 'videoEnv') as Parameters<typeof openExportVideo>[0],
            ),
        )
    })
    await expect(videoDialog(page)).toBeVisible()
    await expect.poll(() => bytes(page)).toBe(0)
    await settle(page)
    // Any frame drawn between the two openings had every atlas.
    const between = (await account(page)).frames.slice(before.frames.length)
    for (const frame of between) expect(frame).toEqual(last)
    await closeDialog(page)
    const [first] = await framesAfter(page, before.frames.length + between.length)
    expect(first).toEqual(last)
    await settle(page)
    expect((await picture(page)).equals(shown)).toBe(true)
    expect(await frameCount(page)).toBe(before.frames.length + between.length + 1)
})

test('a resize while Export Video is open draws nothing until it closes, then draws at the new size', async ({
    page,
}) => {
    await boot(page)
    const last = (await account(page)).frames.at(-1)!
    await openVideoDialog(page)
    await expect.poll(() => bytes(page)).toBe(0)
    await settle(page)
    const counted = await counts(page)
    const count = await frameCount(page)
    const size = () =>
        page
            .locator('.preview-viewport > canvas:not(.preview-selection)')
            .evaluate((canvas) => [canvas.clientWidth, canvas.clientHeight])
    const shown = await size()
    await page.setViewportSize({ width: 1000, height: 900 })
    await expect.poll(size).not.toEqual(shown)
    await settle(page)
    expect(await counts(page)).toEqual(counted)
    expect(await frameCount(page)).toBe(count)
    await closeDialog(page)
    const [first] = await framesAfter(page, count)
    expect(first!.slots).toContain(0)
    expect([first!.width, first!.height]).not.toEqual([last.width, last.height])
    // A later frame at rest has the same size.
    await settle(page)
    await page.evaluate(() => (window.editorTest.view.cursorTime += 0.01))
    const [rest] = await framesAfter(page, count + 1)
    expect([first!.width, first!.height]).toEqual([rest!.width, rest!.height])
})

test('a context lost and restored while Export Video is open gets its atlases when it closes', async ({
    page,
}) => {
    const worker = test.info().project.name === 'chromium-worker'
    await boot(page)
    await openVideoDialog(page)
    await expect.poll(() => bytes(page)).toBe(0)
    const counted = await counts(page)
    await page.evaluate(async (worker) => {
        // The worker host's context is lost in the worker, where only the host can reach it.
        if (worker) {
            await window.nsePreviewTest!.setContextLost(true)
            await window.nsePreviewTest!.setContextLost(false)
            return
        }
        const canvas = document.querySelector<HTMLCanvasElement>(
            '.preview-viewport > canvas:not(.preview-selection)',
        )!
        const gl = canvas.getContext('webgl2')!
        const extension = gl.getExtension('WEBGL_lose_context')!
        const lost = new Promise((resolve) => {
            canvas.addEventListener('webglcontextlost', resolve, { once: true })
        })
        extension.loseContext()
        await lost
        // A restore is allowed once the event's dispatch has ended.
        await new Promise((resolve) => setTimeout(resolve))
        extension.restoreContext()
    }, worker)
    if (!worker)
        await expect
            .poll(() =>
                page.evaluate(() =>
                    document
                        .querySelector<HTMLCanvasElement>(
                            '.preview-viewport > canvas:not(.preview-selection)',
                        )!
                        .getContext('webgl2')!
                        .isContextLost(),
                ),
            )
            .toBe(false)
    await settle(page)
    expect(await counts(page)).toEqual(counted)
    expect(await bytes(page)).toBe(0)
    await closeDialog(page)
    await expect
        .poll(() => page.evaluate(() => window.previewTest.uploads))
        .toBe(counted.uploads + 2)
    await settle(page)
    expect((await counts(page)).frames).toBeGreaterThan(counted.frames)
    expect(await drawnSlots(page)).toContain(0)
})

for (const failure of ['throws', 'hangs'] as const)
    test(`a worker that ${failure} on a frame while Export Video is open hands over, and the main host uploads when it closes`, async ({
        page,
    }) => {
        test.skip(test.info().project.name !== 'chromium-worker', 'The worker host only')
        // A hung worker is stopped after this long without an answer.
        await page.addInitScript(() => {
            localStorage.setItem('nse.test.previewWorker', JSON.stringify({ timeoutMs: 2000 }))
        })
        await boot(page)
        await openVideoDialog(page)
        await expect.poll(() => bytes(page)).toBe(0)
        const counted = await counts(page)
        const worker = previewWorker(page)
        await worker.evaluate((failure: string) => {
            const scope = self as unknown as { onmessage: (event: MessageEvent) => void }
            const handle = scope.onmessage
            scope.onmessage = (event: MessageEvent<{ type: string }>) => {
                if (event.data.type === 'frame') {
                    if (failure === 'throws') throw new Error('The preview worker failed (test)')
                    for (;;);
                }
                handle(event)
            }
        }, failure)
        // A new cursor time makes the page post a frame.
        await page.evaluate(() => (window.editorTest.view.cursorTime = 0.9))
        await expect.poll(() => host(page), { timeout: 10_000 }).toBe('main')
        await settle(page)
        expect(await counts(page)).toEqual(counted)
        await closeDialog(page)
        await expect
            .poll(() => page.evaluate(() => window.previewTest.uploads))
            .toBe(counted.uploads + 2)
        await settle(page)
        expect((await counts(page)).frames).toBeGreaterThan(counted.frames)
        expect(await drawnSlots(page)).toContain(0)
        expect(await bytes(page)).toBeGreaterThan(0)
    })

/**
 * Makes the drawing realm's `getError` report an upload's allocation failure, or an error left
 * by an earlier call. Returns whether the injected error was read.
 */
const injectGlError = async (page: Page, kind: 'upload' | 'earlier') => {
    const inject = (kind: 'upload' | 'earlier') => {
        const isPreview = (gl: WebGL2RenderingContext) =>
            typeof HTMLCanvasElement === 'undefined'
                ? gl.canvas instanceof OffscreenCanvas
                : gl.canvas instanceof HTMLCanvasElement &&
                  gl.canvas.matches('.preview-viewport > canvas:not(.preview-selection)')
        const prototype = WebGL2RenderingContext.prototype
        const getError = prototype.getError
        const upload = prototype.texImage2D
        let uploaded = false
        let pending: boolean = kind === 'earlier'
        Reflect.set(globalThis, 'glErrorRead', false)
        prototype.texImage2D = function (...args: unknown[]) {
            if (isPreview(this) && args.some((arg) => arg instanceof ImageBitmap)) uploaded = true
            return Reflect.apply(upload, this, args)
        }
        prototype.getError = function () {
            if (isPreview(this) && (pending || (kind === 'upload' && uploaded))) {
                pending = false
                kind = 'earlier'
                Reflect.set(globalThis, 'glErrorRead', true)
                return uploaded ? this.OUT_OF_MEMORY : this.INVALID_ENUM
            }
            return getError.call(this)
        }
    }
    if ((await host(page)) === 'main') {
        await page.evaluate(inject, kind)
        return () => page.evaluate(() => Reflect.get(globalThis, 'glErrorRead') as boolean)
    }
    const worker = previewWorker(page)
    await worker.evaluate(inject, kind)
    return () => worker.evaluate(() => Reflect.get(globalThis, 'glErrorRead') as boolean)
}

test('an upload that fails on closing Export Video shows the graphics error or hands over', async ({
    page,
}) => {
    const worker = test.info().project.name === 'chromium-worker'
    await boot(page)
    await openVideoDialog(page)
    await expect.poll(() => bytes(page)).toBe(0)
    const counted = await counts(page)
    const read = await injectGlError(page, 'upload')
    await closeDialog(page)
    if (!worker) {
        await expect(
            page.locator('.preview').getByText('The preview could not be displayed.'),
        ).toBeVisible()
        await expect(
            page.locator('.preview').getByRole('button', { name: 'Reload', exact: true }),
        ).toBeVisible()
        expect(await read()).toBe(true)
        return
    }
    // The main host draws with the atlases the worker hands back.
    await expect.poll(() => host(page)).toBe('main')
    await expect
        .poll(() => page.evaluate(() => window.previewTest.uploads))
        .toBeGreaterThanOrEqual(counted.uploads + 2)
    await settle(page)
    expect((await counts(page)).frames).toBeGreaterThan(counted.frames)
    expect(await drawnSlots(page)).toContain(0)
})

test('an error left by an earlier GL call does not fail the upload on closing Export Video', async ({
    page,
}) => {
    const worker = test.info().project.name === 'chromium-worker'
    await boot(page)
    const shown = await picture(page)
    await openVideoDialog(page)
    await expect.poll(() => bytes(page)).toBe(0)
    const counted = await counts(page)
    const read = await injectGlError(page, 'earlier')
    await closeDialog(page)
    await expect
        .poll(() => page.evaluate(() => window.previewTest.uploads))
        .toBe(counted.uploads + 2)
    await settle(page)
    expect(await read()).toBe(true)
    expect(await host(page)).toBe(worker ? 'worker' : 'main')
    await expect(
        page.locator('.preview').getByText('The preview could not be displayed.'),
    ).toHaveCount(0)
    expect((await picture(page)).equals(shown)).toBe(true)
})
