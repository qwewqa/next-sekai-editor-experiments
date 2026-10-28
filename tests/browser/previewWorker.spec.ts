import { expect, test, type Browser, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'
import { outlinePixels, resource } from './previewResourceFixture'

// The worker host (nse.test.previewHost=worker): it draws in the preview's worker, hands over
// to the main host when the worker fails, and draws what the main host draws.

declare global {
    interface Window {
        hostTest: {
            mainFrames: number
            decodes: number
            /** Preview workers terminated. */
            terminated: number
            freezeAudio?: (time?: number) => void
            /** Holds animation frames until `resumeFrames`. */
            holdFrames?: () => void
            resumeFrames?: () => void
        }
    }
}

const settle = (page: Page) =>
    page.evaluate(async () => {
        await window.editorTest.nextTick()
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
    })

/** `setting` leaves the host to the setting, stored as given unless undefined. */
type Host = 'main' | 'worker' | { setting?: boolean }

const open = async (page: Page, host: Host, flags: Record<string, unknown> = {}) => {
    await page.route('**/resource/skin.scp*', (route) => route.fulfill({ body: resource('skins') }))
    await page.route('**/resource/particle.scp*', (route) =>
        route.fulfill({ body: resource('particles') }),
    )
    await page.addInitScript(installCanvasCounters)
    await page.addInitScript(
        ({ host, flags }) => {
            if (typeof host === 'string') localStorage.setItem('nse.test.previewHost', host)
            else {
                localStorage.removeItem('nse.test.previewHost')
                if (host.setting !== undefined)
                    localStorage.setItem(
                        'sonolus-next-sekai-editor.previewInWorker',
                        JSON.stringify(host.setting),
                    )
            }
            localStorage.setItem('nse.test.previewWorker', JSON.stringify(flags))
            // The worker reports its counters here; the main host's are counted below.
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
            window.hostTest = { mainFrames: 0, decodes: 0, terminated: 0 }
            // A page without focus draws nothing, as when the app is in the background.
            Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })
            const clear = WebGL2RenderingContext.prototype.clear
            WebGL2RenderingContext.prototype.clear = function (...args) {
                if (
                    this.canvas instanceof HTMLCanvasElement &&
                    this.canvas.matches('.preview-viewport > canvas:not(.preview-selection)')
                )
                    window.hostTest.mainFrames++
                return clear.apply(this, args)
            }
            const decode = window.createImageBitmap
            window.createImageBitmap = (async (...args: unknown[]) => {
                const options = args[1] as ImageBitmapOptions | undefined
                if (args[0] instanceof Blob && options?.premultiplyAlpha === 'premultiply')
                    window.hostTest.decodes++
                return (await Reflect.apply(decode, window, args)) as ImageBitmap
            }) as typeof createImageBitmap
            // A frozen audio clock holds playback at one time, for a playing frame.
            const time = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, 'currentTime')!
            let frozen: number | undefined
            Object.defineProperty(BaseAudioContext.prototype, 'currentTime', {
                configurable: true,
                get(this: BaseAudioContext) {
                    return frozen ?? (time.get!.call(this) as number)
                },
            })
            window.hostTest.freezeAudio = (value) => {
                frozen = value
            }
            // Held frames run on resume. Their ids map to the new ones, so a cancel still works.
            const raf = window.requestAnimationFrame.bind(window)
            const caf = window.cancelAnimationFrame.bind(window)
            let held: Map<number, FrameRequestCallback> | undefined
            const resumed = new Map<number, number>()
            let heldId = 1e9
            window.requestAnimationFrame = (callback) => {
                if (!held) return raf(callback)
                held.set(++heldId, callback)
                return heldId
            }
            window.cancelAnimationFrame = (id) => {
                if (!held?.delete(id)) caf(resumed.get(id) ?? id)
            }
            window.hostTest.holdFrames = () => {
                held = new Map()
            }
            window.hostTest.resumeFrames = () => {
                const callbacks = held ?? new Map<number, FrameRequestCallback>()
                held = undefined
                for (const [id, callback] of callbacks) resumed.set(id, raf(callback))
            }
            // A preview worker is the one sent the start message.
            const previewWorkers = new WeakSet<Worker>()
            const postMessage = Worker.prototype.postMessage
            Worker.prototype.postMessage = function (this: Worker, ...args: unknown[]) {
                const message = args[0] as { type?: string; flags?: unknown } | undefined
                if (message?.type === 'start' && message.flags) previewWorkers.add(this)
                return Reflect.apply(postMessage, this, args) as void
            }
            const terminate = Worker.prototype.terminate
            Worker.prototype.terminate = function (this: Worker) {
                if (previewWorkers.has(this)) window.hostTest.terminated++
                terminate.call(this)
            }
        },
        { host, flags },
    )
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.evaluate(installEditorFixture)
    await page.evaluate(() => {
        const { fixtures, show, history, view, settings } = window.editorTest
        const base = fixtures.interaction.slides[0]![0]!
        show(
            {
                ...fixtures.interaction,
                slides: [
                    [
                        { ...base, beat: 6, left: -3 },
                        { ...base, beat: 8, left: 1 },
                    ],
                    [{ ...base, beat: 7, left: 3, size: 1 }],
                ],
            },
            3,
        )
        view.cursorTime = 3
        const { note, connector } = history.state.value.store.slides
        history.replaceState({
            ...history.state.value,
            selectedEntities: [...note.values(), ...connector.values()].flat(),
        })
        settings.showPreview = true
    })
    await expect(
        page.locator('.preview-controls').getByText('Note Speed', { exact: true }),
    ).toBeVisible()
}

const hostOf = (page: Page) => page.evaluate(() => window.nsePreviewTest?.host)

/** Draws new frames, each once the last is drawn, until the worker fails and hands over. */
const drawUntilHandover = async (page: Page) => {
    for (let i = 1; i < 6 && (await hostOf(page)) === 'worker'; i++) {
        const frames = await page.evaluate(() => window.previewTest.frames)
        await page.evaluate((i) => (window.editorTest.view.cursorTime = 3 + i / 20), i)
        await expect
            .poll(
                async () =>
                    (await hostOf(page)) === 'main' ||
                    (await page.evaluate(() => window.previewTest.frames)) > frames,
                { timeout: 10_000 },
            )
            .toBe(true)
    }
    await expect.poll(() => hostOf(page), { timeout: 10_000 }).toBe('main')
}

const diagnostics = (page: Page) =>
    page.evaluate(async () => {
        const { ringEntries } =
            await window.editorTest.appImport<typeof import('../../src/diagnostics')>(
                '/src/diagnostics.ts',
            )
        return ringEntries().map((entry) => entry.text)
    })

test('the worker host draws the preview and its outline in the worker', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await open(page, 'worker')
    expect(await hostOf(page)).toBe('worker')
    await expect.poll(() => page.evaluate(() => window.previewTest.uploads)).toBe(2)
    await expect.poll(() => page.evaluate(() => window.previewTest.frames)).toBeGreaterThan(0)
    await expect.poll(() => outlinePixels(page)).toBeGreaterThan(0)
    // The canvases belong to the worker: the page cannot draw into them.
    expect(
        await page.evaluate(() => {
            try {
                document
                    .querySelector<HTMLCanvasElement>('.preview-viewport canvas')!
                    .getContext('webgl2')
                return 'context'
            } catch (error) {
                return (error as Error).name
            }
        }),
    ).toBe('InvalidStateError')
    // A paused frame changes only with its inputs.
    const frames = await page.evaluate(() => window.previewTest.frames)
    await settle(page)
    expect(await page.evaluate(() => window.previewTest.frames)).toBe(frames)
    await page.evaluate(() => (window.editorTest.view.cursorTime = 3.2))
    await expect.poll(() => page.evaluate(() => window.previewTest.frames)).toBeGreaterThan(frames)
    expect(await page.evaluate(() => window.hostTest.mainFrames)).toBe(0)
    expect(errors).toEqual([])
})

test('a skin switch moves the new atlas to the worker, which keeps drawing', async ({ page }) => {
    await page.route('**/builtin/skin.scp*', (route) => route.fulfill({ body: resource('skins') }))
    await open(page, 'worker')
    await expect.poll(() => page.evaluate(() => window.previewTest.uploads)).toBe(2)
    for (const [source, uploads] of [
        ['builtin', 3],
        ['default', 4],
    ] as const) {
        const frames = await page.evaluate(() => window.previewTest.frames)
        await page.evaluate((source) => {
            const { settings } = window.editorTest
            settings.previewAssets = { ...settings.previewAssets, skin: { source } }
        }, source)
        await expect.poll(() => page.evaluate(() => window.previewTest.uploads)).toBe(uploads)
        await expect
            .poll(() => page.evaluate(() => window.previewTest.frames))
            .toBeGreaterThan(frames)
    }
    // Each switch decodes its skin once, on the main thread.
    expect(await page.evaluate(() => window.hostTest.decodes)).toBe(4)
    expect(await hostOf(page)).toBe('worker')
})

test('by default the preview draws in its worker', async ({ page }) => {
    await open(page, {})
    expect(await hostOf(page)).toBe('worker')
    expect(await page.evaluate(() => window.editorTest.settings.previewInWorker)).toBe(true)
    await expect.poll(() => page.evaluate(() => window.previewTest.frames)).toBeGreaterThan(0)
    await expect.poll(() => outlinePixels(page)).toBeGreaterThan(0)
})

test('the setting moves the preview between hosts at once, and it keeps drawing', async ({
    page,
}) => {
    await open(page, { setting: true })
    expect(await hostOf(page)).toBe('worker')
    await expect.poll(() => page.evaluate(() => window.previewTest.uploads)).toBe(2)
    for (const [on, host] of [
        [false, 'main'],
        [true, 'worker'],
        [false, 'main'],
    ] as const) {
        const drawn = () =>
            page.evaluate((host) => {
                const { previewTest, hostTest } = window
                return host === 'main' ? hostTest.mainFrames : previewTest.frames
            }, host)
        const before = await drawn()
        // The first change through Settings › Preview.
        if (!on && host === 'main' && before === 0) {
            await page.keyboard.press(',')
            const toggle = page
                .getByRole('dialog')
                .getByRole('switch', { name: 'Parallel Rendering', exact: true })
            await toggle.click()
            await expect(toggle).toHaveValue('Disabled')
            await page.keyboard.press('Escape')
            await expect(page.getByRole('dialog')).toHaveCount(0)
        } else await page.evaluate((on) => (window.editorTest.settings.previewInWorker = on), on)
        await expect.poll(() => hostOf(page)).toBe(host)
        await expect.poll(drawn).toBeGreaterThan(before)
        await expect.poll(() => outlinePixels(page)).toBeGreaterThan(0)
        // The panel has one host's canvases again, and draws a new time.
        await expect(page.locator('.preview-viewport canvas')).toHaveCount(2)
        const now = await drawn()
        await page.evaluate(() => (window.editorTest.view.cursorTime += 0.1))
        await expect.poll(drawn).toBeGreaterThan(now)
    }
    // The atlases moved back and forth; nothing was decoded again.
    expect(await page.evaluate(() => window.hostTest.decodes)).toBe(2)
    await expect(page.locator('.preview')).not.toContainText('could not be displayed')
})

test('the setting off and on again while the worker stops starts one that draws', async ({
    page,
}) => {
    await open(page, { setting: true })
    await expect.poll(() => page.evaluate(() => window.previewTest.uploads)).toBe(2)
    // On again before the first worker has handed its atlases back.
    await page.evaluate(async () => {
        const { settings, nextTick } = window.editorTest
        settings.previewInWorker = false
        await nextTick()
        settings.previewInWorker = true
    })
    // The first worker stops and hands its atlases back; a second one gets new canvases.
    await expect.poll(() => page.evaluate(() => window.previewTest.uploads)).toBe(4)
    expect(await hostOf(page)).toBe('worker')
    const frames = await page.evaluate(() => window.previewTest.frames)
    await page.evaluate(() => (window.editorTest.view.cursorTime += 0.1))
    await expect.poll(() => page.evaluate(() => window.previewTest.frames)).toBeGreaterThan(frames)
    await expect.poll(() => outlinePixels(page)).toBeGreaterThan(0)
    await expect(page.locator('.preview-viewport canvas')).toHaveCount(2)
})

test("after a hang, the worker's last frame shows until the skin is decoded again", async ({
    page,
}) => {
    await open(page, 'worker', { hangOnFrame: 2, timeoutMs: 8000 })
    // The skin's second download is slow, so the main host draws before it has a skin.
    let requests = 0
    let release = () => {}
    const released = new Promise<void>((resolve) => (release = resolve))
    await page.route('**/resource/skin.scp*', async (route) => {
        if (++requests > 0) await released
        await route.fulfill({ body: resource('skins') })
    })
    await drawUntilHandover(page)
    await expect.poll(() => page.evaluate(() => window.hostTest.mainFrames)).toBeGreaterThan(0)
    await page.evaluate(() => (window.editorTest.view.cursorTime = 3.5))
    await settle(page)
    // Both hosts' canvases: the worker's last frame under the main host's empty one.
    await expect(page.locator('.preview-viewport canvas')).toHaveCount(4)
    release()
    await expect.poll(() => page.evaluate(() => window.hostTest.decodes)).toBe(4)
    await expect(page.locator('.preview-viewport canvas')).toHaveCount(2)
    await expect.poll(() => outlinePixels(page)).toBeGreaterThan(0)
})

test("with the setting on, a failing worker still hands over for the page's life", async ({
    page,
}) => {
    await open(page, { setting: true }, { throwOnFrame: 1 })
    await expect.poll(() => hostOf(page)).toBe('main')
    await expect.poll(() => page.evaluate(() => window.hostTest.mainFrames)).toBeGreaterThan(0)
    // Turning the setting off and on again keeps the main thread drawing.
    await page.evaluate(() => (window.editorTest.settings.previewInWorker = false))
    await page.evaluate(() => (window.editorTest.settings.previewInWorker = true))
    await settle(page)
    expect(await hostOf(page)).toBe('main')
    expect(await page.evaluate(() => window.editorTest.settings.previewInWorker)).toBe(true)
})

test("a replaced canvas's context, and a stopped worker, go only after the page draws without them", async ({
    page,
}) => {
    await open(page, { setting: true })
    await expect.poll(() => page.evaluate(() => window.previewTest.uploads)).toBe(2)
    await expect.poll(() => page.evaluate(() => window.previewTest.frames)).toBeGreaterThan(0)
    // A new canvas while frames are held. The old one keeps its context until two frames pass.
    await page.evaluate(() => {
        window.hostTest.holdFrames!()
        window.editorTest.settings.previewAntialias = false
    })
    await expect.poll(() => page.evaluate(() => window.previewTest.uploads)).toBe(4)
    expect(await page.evaluate(() => window.previewTest.releases ?? 0)).toBe(0)
    await page.evaluate(() => window.hostTest.resumeFrames!())
    await expect.poll(() => page.evaluate(() => window.previewTest.releases ?? 0)).toBe(1)
    // The setting off while frames are held. The worker hands the atlases back and keeps its
    // canvases.
    await page.evaluate(() => {
        window.hostTest.holdFrames!()
        window.editorTest.settings.previewInWorker = false
    })
    await expect.poll(() => hostOf(page)).toBe('main')
    expect(await page.evaluate(() => window.hostTest.terminated)).toBe(0)
    await page.evaluate(() => window.hostTest.resumeFrames!())
    await expect.poll(() => page.evaluate(() => window.hostTest.mainFrames)).toBeGreaterThan(0)
    await expect.poll(() => page.evaluate(() => window.hostTest.terminated)).toBe(1)
    await expect(page.locator('.preview-viewport canvas')).toHaveCount(2)
})

test('the worker host restores a lost context and uploads the atlases again', async ({ page }) => {
    await open(page, 'worker')
    await expect.poll(() => page.evaluate(() => window.previewTest.uploads)).toBe(2)
    await page.evaluate(() => window.nsePreviewTest!.setContextLost(true))
    const frames = await page.evaluate(() => window.previewTest.frames)
    await page.evaluate(() => (window.editorTest.view.cursorTime = 3.2))
    await settle(page)
    expect(await page.evaluate(() => window.previewTest.frames)).toBe(frames)
    await page.evaluate(() => window.nsePreviewTest!.setContextLost(false))
    await expect.poll(() => page.evaluate(() => window.previewTest.uploads)).toBe(4)
    await expect.poll(() => page.evaluate(() => window.previewTest.frames)).toBeGreaterThan(frames)
    expect(await page.evaluate(() => window.hostTest.decodes)).toBe(2)
    expect(await hostOf(page)).toBe('worker')
})

for (const [label, flags, decodedAgain] of [
    ['its WebGL2 context is unavailable', { noWebgl: true }, false],
    ['an error escapes the worker', { throwOnStart: true }, false],
    ['it throws while drawing', { throwOnFrame: 3 }, false],
    ['a frame gets no answer', { hangOnFrame: 3, timeoutMs: 1500 }, true],
] as const) {
    test(`the preview draws on the main thread when the worker fails: ${label}`, async ({
        page,
    }) => {
        await open(page, 'worker', flags)
        await drawUntilHandover(page)
        await expect.poll(() => page.evaluate(() => window.hostTest.mainFrames)).toBeGreaterThan(0)
        await expect.poll(() => outlinePixels(page)).toBeGreaterThan(0)
        // The worker's canvases go once the main host has drawn.
        await expect(page.locator('.preview-viewport canvas')).toHaveCount(2)
        await expect(page.locator('.preview')).not.toContainText('could not be displayed')
        // The atlases came back from a worker that answered, else they were decoded again.
        await expect
            .poll(() => page.evaluate(() => window.hostTest.decodes))
            .toBe(decodedAgain ? 4 : 2)
        const frames = await page.evaluate(() => window.hostTest.mainFrames)
        await page.evaluate(() => (window.editorTest.view.cursorTime = 3.4))
        await expect
            .poll(() => page.evaluate(() => window.hostTest.mainFrames))
            .toBeGreaterThan(frames)
        // No notice: only the startup's version line may still show.
        await expect(
            page.locator('.notification, .notification-pill').filter({ hasNotText: /Version \d/ }),
        ).toHaveCount(0)
        expect((await diagnostics(page)).join('\n')).toContain(
            'The preview worker stopped, and the preview draws on the main thread',
        )
    })
}

// Each host in a page of its own, compared by their composited pixels.
const pair = async (browser: Browser) => {
    const pages = []
    for (const host of ['main', 'worker'] as const) {
        const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
        const page = await context.newPage()
        await open(page, host)
        await expect.poll(() => outlinePixels(page)).toBeGreaterThan(0)
        expect(await hostOf(page)).toBe(host)
        pages.push(page)
    }
    return pages as [Page, Page]
}

const shot = async (page: Page) => {
    await settle(page)
    await settle(page)
    return page.locator('.preview-viewport').screenshot({ animations: 'disabled' })
}

test('both hosts draw the same pixels, paused and playing, with everything selected', async ({
    browser,
    browserName,
}) => {
    const pages = await pair(browser)
    const compare = async (label: string) => {
        const [main, worker] = (await Promise.all(pages.map(shot))) as [Buffer, Buffer]
        if (browserName === 'chromium') {
            expect(worker.equals(main), label).toBe(true)
            return
        }
        // Firefox's contexts differ by a few levels at some edge pixels, any two of them.
        const { differing, maxLevel, pixels } = await pages[0].evaluate(
            async ([a, b]) => {
                const decode = async (png: string) => {
                    const image = new Image()
                    image.src = `data:image/png;base64,${png}`
                    await image.decode()
                    const canvas = document.createElement('canvas')
                    canvas.width = image.naturalWidth
                    canvas.height = image.naturalHeight
                    const ctx = canvas.getContext('2d')!
                    ctx.drawImage(image, 0, 0)
                    return ctx.getImageData(0, 0, canvas.width, canvas.height).data
                }
                const [x, y] = await Promise.all([decode(a), decode(b)])
                let differing = 0
                let maxLevel = 0
                for (let i = 0; i < x.length; i += 4) {
                    let level = 0
                    for (let c = 0; c < 4; c++)
                        level = Math.max(level, Math.abs(x[i + c]! - y[i + c]!))
                    if (level) differing++
                    maxLevel = Math.max(maxLevel, level)
                }
                return { differing, maxLevel, pixels: x.length / 4 }
            },
            [main.toString('base64'), worker.toString('base64')] as const,
        )
        expect(maxLevel, label).toBeLessThanOrEqual(8)
        expect(differing / pixels, label).toBeLessThan(0.005)
    }
    // Each host draws a new frame for each change, so no comparison is of stale frames.
    const drawn = (page: Page) =>
        page.evaluate(() => window.hostTest.mainFrames + window.previewTest.frames)
    const change = async (apply: (time: number) => void, time = 0) => {
        for (const page of pages) {
            const before = await drawn(page)
            await page.evaluate(apply, time)
            await expect.poll(() => drawn(page)).toBeGreaterThan(before)
        }
    }
    for (const time of [3.5, 4, 3]) {
        await change((time) => (window.editorTest.view.cursorTime = time), time)
        await compare(`paused at ${time}`)
    }
    await change(() => (window.editorTest.settings.previewShowHitboxes = true))
    await compare('paused with hitboxes')
    // Playing, with the audio clock held so the time stays put.
    const playing = []
    for (const page of pages)
        playing.push(
            await page.evaluate(async () => {
                window.editorTest.view.cursorTime = 3.25
                await window.editorTest.nextTick()
                const { startOrStopPlayer } =
                    await window.editorTest.appImport<typeof import('../../src/editor/player')>(
                        '/src/editor/player.ts',
                    )
                const { isPlaying } =
                    await window.editorTest.appImport<typeof import('../../src/player')>(
                        '/src/player.ts',
                    )
                window.hostTest.freezeAudio!(1)
                startOrStopPlayer()
                await new Promise((resolve) => setTimeout(resolve, 400))
                return { playing: isPlaying.value, time: window.editorTest.view.cursorTime }
            }),
        )
    // Both pages hold the same playing time.
    expect(playing[1]).toEqual(playing[0])
    expect(playing[0]?.playing).toBe(true)
    await compare('playing')
    for (const page of pages) await page.context().close()
})
