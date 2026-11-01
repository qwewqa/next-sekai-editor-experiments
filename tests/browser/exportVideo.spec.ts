import { expect, test } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'
import { resource } from './previewResourceFixture'

test.beforeEach(async ({ page }) => {
    await page.route('**/resource/skin.scp*', (route) => route.fulfill({ body: resource('skins') }))
    await page.route('**/resource/particle.scp*', (route) =>
        route.fulfill({ body: resource('particles') }),
    )
    await page.addInitScript(installCanvasCounters)
    await page.goto('/')
    await page.evaluate(installEditorFixture)
    await page.evaluate(() => window.editorTest.show(window.editorTest.fixtures.notes))
})

for (const start of [0, 83])
    test(`encodes a clip at ${start} s with exact frames and audio trims`, async ({ page }) => {
        const result = await page.evaluate(
            (start) => window.editorTest.exportVideo({ settings: { in: start, frames: 76 } }),
            start,
        )
        expect(result.error).toBeUndefined()
        expect(result.phase).toBe('ready')
        expect(result.guarded).toBe(true)
        expect(result.retained).toBe(false)
        expect(result.runningPixels).toBe(320 * 180)
        expect(result.markerLeft).toBe(false)
        const sink = result.result as {
            frames: number
            duration: number
            timing: { playableSamples: number; startSamples: number }
            padding: number
            inputs: { track: string; packet?: { timestamp: number; duration: number } }[]
        }
        expect(sink.frames).toBe(76)
        expect(sink.duration).toBe(2533333)
        expect(sink.timing.playableSamples).toBe(121600)
        expect(sink.timing.startSamples).toBeGreaterThanOrEqual(1024)
        expect(sink.padding).toBeGreaterThanOrEqual(0)
        expect(sink.inputs.filter((i) => i.track === 'video')).toHaveLength(76)
        expect(sink.inputs.find((i) => i.track === 'audio')?.packet?.timestamp).toBe(0)
    })

for (const cancelAt of ['preparing', 'exporting', 'mix', 'drain', 'finalize', 'view'] as const)
    test(`cancel during ${cancelAt} settles and removes the staged file`, async ({ page }) => {
        const result = await page.evaluate(
            (cancelAt) => window.editorTest.exportVideo({ cancelAt }),
            cancelAt,
        )
        expect(result.error).toBeUndefined()
        expect(result.phase).toBe('cancelled')
        expect(result.retained).toBe(false)
        expect(result.guarded).toBe(false)
        expect(result.markerLeft).toBe(false)
        if (cancelAt === 'mix') expect(result.mixStarted).toBe(true)
    })

test('cancel is refused once the commit starts', async ({ page }) => {
    const result = await page.evaluate(() =>
        window.editorTest.exportVideo({ cancelAt: 'finishing', settings: { frames: 3 } }),
    )
    expect(result.error).toBeUndefined()
    expect(result.finishingCancel).toBe(false)
    expect(result.phase).toBe('ready')
})

test('context loss fails without retaining output', async ({ page }) => {
    const result = await page.evaluate(() => window.editorTest.exportVideo({ loseContextAt: 4 }))
    expect(result.phase).toBe('failed')
    expect(result.error).toContain('graphics')
    expect(result.retained).toBe(false)
    expect(result.markerLeft).toBe(false)
})

test('the same worker draws queued views and then exports at the selected size', async ({
    page,
}) => {
    const result = await page.evaluate(() =>
        window.editorTest.exportVideo({ previewFirst: true, parityAt: 0, settings: { frames: 3 } }),
    )
    expect(result.error).toBeUndefined()
    expect(result.viewSize).toEqual([160, 90])
    expect(result.capturedSize).toEqual([320, 180])
    expect(result.phase).toBe('ready')
})

test('copies all textures from a mounted worker preview', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('nse.test.previewHost', 'worker'))
    await page.reload()
    await page.evaluate(installEditorFixture)
    await page.evaluate(async () => {
        window.editorTest.settings.previewInWorker = true
        window.editorTest.settings.showPreview = true
        await window.editorTest.nextTick()
    })
    await expect(page.locator('.preview-viewport')).toBeVisible()
    await expect.poll(() => page.evaluate(() => window.nsePreviewTest?.host)).toBe('worker')
    const result = await page.evaluate(() =>
        window.editorTest.exportVideo({ settings: { frames: 3 } }),
    )
    expect(result.error).toBeUndefined()
    expect(result.phase).toBe('ready')
})

for (const frame of [0, 30, 31])
    test(`raw export frame ${frame} equals the main preview draw`, async ({ page }) => {
        const result = await page.evaluate(
            (frame) => window.editorTest.exportVideo({ parityAt: frame, settings: { frames: 36 } }),
            frame,
        )
        expect(result.error).toBeUndefined()
        expect(result.phase).toBe('ready')
        expect(result.maxError).toBe(0)
    })

for (const renderScale of [1.5, 2] as const)
    test(`MSAA at render scale ${renderScale} matches a CPU area average`, async ({ page }) => {
        const result = await page.evaluate(
            (renderScale) =>
                window.editorTest.exportVideo({
                    parityAt: 0,
                    backgroundBlur: 100,
                    settings: { frames: 3, renderScale, antialias: true, bgm: false, sfx: false },
                }),
            renderScale,
        )
        expect(result.error).toBeUndefined()
        expect(result.phase).toBe('ready')
        expect(result.maxError).toBeLessThanOrEqual(1)
    })

for (const start of [2, 7, 83])
    test(`camera, stage and scroll events match at ${start} s`, async ({ page }) => {
        const result = await page.evaluate((start) => {
            const chart = structuredClone(window.editorTest.fixtures.events)
            chart.isDynamicStages = true
            window.editorTest.show(chart)
            return window.editorTest.exportVideo({
                parityAt: 0,
                settings: { in: start, frames: 3 },
            })
        }, start)
        expect(result.error).toBeUndefined()
        expect(result.maxError).toBe(0)
    })

test('an intentionally black first frame is encoded', async ({ page }) => {
    const result = await page.evaluate(() =>
        window.editorTest.exportVideo({ parityAt: 0, settings: { frames: 3, fadeIn: 0.1 } }),
    )
    expect(result.error).toBeUndefined()
    expect(result.phase).toBe('ready')
    expect(result.capturedMax).toBe(0)
})

test('a failed write retains its file error and removes the staged file', async ({ page }) => {
    const result = await page.evaluate(() => window.editorTest.exportVideo({ failWrite: true }))
    expect(result.phase).toBe('failed')
    expect(result.errorCode).toBe('no-space')
    expect(result.retained).toBe(false)
    expect(result.markerLeft).toBe(false)
})

test('pagehide clears the running marker without cancelling the export', async ({ page }) => {
    const { result, pagehideCleared } = await page.evaluate(async () => {
        const render = OfflineAudioContext.prototype.startRendering
        let pagehideCleared = false
        OfflineAudioContext.prototype.startRendering = function () {
            const markers = Object.keys(localStorage).filter((key) =>
                key.startsWith('exportVideoRunning.'),
            )
            window.dispatchEvent(new PageTransitionEvent('pagehide'))
            pagehideCleared =
                markers.length === 1 && markers.every((key) => localStorage.getItem(key) === null)
            return render.call(this)
        }
        try {
            const result = await window.editorTest.exportVideo({
                settings: { frames: 3, renderScale: 1.5 },
            })
            return { result, pagehideCleared }
        } finally {
            OfflineAudioContext.prototype.startRendering = render
        }
    })
    expect(result.error).toBeUndefined()
    expect(result.phase).toBe('ready')
    expect(result.runningPixels).toBe(480 * 270)
    expect(pagehideCleared).toBe(true)
    expect(result.markerLeft).toBe(false)
})

for (const target of ['foreground', 'composite'] as const)
    for (const hidden of [false, true])
        test(`an incomplete ${target} target reports a ${hidden ? 'background' : 'graphics'} error`, async ({
            page,
        }) => {
            const result = await page.evaluate(
                async ({ target, hidden }) => {
                    Object.defineProperty(document, 'hidden', { configurable: true, value: hidden })
                    try {
                        return await window.editorTest.exportVideo({
                            incompleteTarget: target,
                            settings: { frames: 3, renderScale: 1.5 },
                        })
                    } finally {
                        Reflect.deleteProperty(document, 'hidden')
                    }
                },
                { target, hidden },
            )
            expect(result.phase).toBe('failed')
            expect(result.error).toContain(`${hidden ? 'background' : 'graphics'}:`)
            expect(result.error).toContain('Incomplete preview render target')
            expect(result.retained).toBe(false)
            expect(result.markerLeft).toBe(false)
        })
