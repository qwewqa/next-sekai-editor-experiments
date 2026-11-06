import { expect, test, type Page } from '@playwright/test'
import { installCanvasCounters, installEditorFixture } from './editorFixture'
import { notice } from './historyJourney'
import { wav } from './levelInfoFiles'

type ScheduledSource = {
    id: number
    bgm: boolean
    // Index of its AudioContext in `contexts`.
    context: number
    when: number
    offset: number
    rate: number
    contextTime: number
    performanceTime: number
}

declare global {
    interface Window {
        audioResilience: {
            context?: AudioContext
            contexts: AudioContext[]
            player?: typeof import('../../src/editor/player')
            audition?: typeof import('../../src/editor/audioPreview')
            isPlaying?: () => boolean
            decoded: number
            starts: ScheduledSource[]
            stopped: number[]
            ended: number[]
            errors: string[]
            resumeRequestedAt?: number
            resumeResolvedAt?: number
            interruption?: { active: boolean; resumes: number }
        }
    }
}

// These tests intentionally use native audio and performance clocks. A mocked
// animation clock cannot reproduce an independently suspended audio context.
const settle = (page: Page) =>
    page.evaluate(async () => {
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
        await window.editorTest.nextTick()
    })

// Read in a frame, after playback moved the cursor in it: between frames the audio runs ahead of
// the cursor by however long the next frame is late, which a busy machine stretches.
const snapshot = (page: Page) =>
    page.evaluate(
        () =>
            new Promise<{
                state: AudioContextState
                audioTime: number
                cursor: number
                audioPosition: number
                playing: boolean
                bgmStarts: number
            }>((resolve) =>
                requestAnimationFrame(() => {
                    const probe = window.audioResilience
                    const context = probe.context!
                    const bgm = probe.starts.filter((source) => source.bgm).at(-1)
                    resolve({
                        state: context.state,
                        audioTime: context.currentTime,
                        cursor: window.editorTest.view.cursorTime,
                        audioPosition: bgm
                            ? bgm.offset + Math.max(0, context.currentTime - bgm.when) * bgm.rate
                            : 0,
                        playing: probe.isPlaying!(),
                        bgmStarts: probe.starts.filter((source) => source.bgm).length,
                    })
                }),
            ),
    )

const delayResume = (page: Page) =>
    page.evaluate(async () => {
        const probe = window.audioResilience
        const context = probe.context!
        await context.suspend()
        const resume = context.resume.bind(context)
        context.resume = async () => {
            probe.resumeRequestedAt = performance.now()
            await new Promise((resolve) => setTimeout(resolve, 300))
            await resume()
            probe.resumeResolvedAt = performance.now()
        }
    })

const toggle = (page: Page) =>
    page.evaluate(() => window.audioResilience.player!.togglePreviewPlayback())

const cursor = (page: Page) => page.evaluate(() => window.editorTest.view.cursorTime)

const isPlaying = (page: Page) => page.evaluate(() => window.audioResilience.isPlaying!())

const contextCount = (page: Page) => page.evaluate(() => window.audioResilience.contexts.length)

// The current context's clock stops where it is, and its state stays as it was.
const freezeClock = (page: Page) =>
    page.evaluate(() => {
        const context = window.audioResilience.context!
        const time = context.currentTime
        Object.defineProperty(context, 'currentTime', { configurable: true, get: () => time })
    })

const startFailed = 'Could not start playback. Try again.'

// Waits past the start deadline.
const untilStopped = (page: Page) =>
    expect.poll(() => isPlaying(page), { timeout: 10_000 }).toBe(false)

// The ids of sources that started and were neither stopped nor ended.
const unstopped = (page: Page) =>
    page.evaluate(() => {
        const { starts, stopped, ended } = window.audioResilience
        return starts
            .filter((source) => !stopped.includes(source.id) && !ended.includes(source.id))
            .map((source) => source.id)
    })

test.beforeEach(async ({ page }) => {
    await page.addInitScript(installCanvasCounters)
    await page.addInitScript(() => {
        localStorage.setItem('sonolus-next-sekai-editor.playPreviewDuration', '0')
        const probe = (window.audioResilience = {
            decoded: 0,
            starts: [] as ScheduledSource[],
            stopped: [] as number[],
            ended: [] as number[],
            errors: [] as string[],
            context: undefined as AudioContext | undefined,
            contexts: [] as AudioContext[],
        })
        window.AudioContext = new Proxy(AudioContext, {
            construct(target, args) {
                const context = Reflect.construct(target, args) as AudioContext
                probe.context = context
                probe.contexts.push(context)
                return context
            },
        })
        const decode = AudioContext.prototype.decodeAudioData
        AudioContext.prototype.decodeAudioData = function (...args) {
            return (Reflect.apply(decode, this, args) as Promise<AudioBuffer>).then((buffer) => {
                probe.decoded++
                return buffer
            })
        }
        let nextId = 0
        const ids = new WeakMap<AudioBufferSourceNode, number>()
        const start = AudioBufferSourceNode.prototype.start
        AudioBufferSourceNode.prototype.start = function (when = 0, offset = 0, duration) {
            const id = nextId++
            ids.set(this, id)
            this.addEventListener('ended', () => probe.ended.push(id))
            probe.starts.push({
                id,
                bgm: this.buffer === window.editorTest?.history.state.value.bgm.buffer,
                context: probe.contexts.indexOf(this.context as AudioContext),
                when,
                offset,
                rate: this.playbackRate.value,
                contextTime: this.context.currentTime,
                performanceTime: performance.now(),
            })
            start.call(this, when, offset, duration)
        }
        const stop = AudioBufferSourceNode.prototype.stop
        AudioBufferSourceNode.prototype.stop = function (when) {
            const id = ids.get(this)
            if (id !== undefined) probe.stopped.push(id)
            stop.call(this, when)
        }
        window.addEventListener('error', (event) => probe.errors.push(event.message))
        window.addEventListener('unhandledrejection', (event) =>
            probe.errors.push(String(event.reason)),
        )
    })
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await page.keyboard.press('Shift')
    await page.evaluate(installEditorFixture)
    await expect
        .poll(() => page.evaluate(() => window.audioResilience.decoded))
        .toBeGreaterThanOrEqual(10)
    await page.evaluate(async () => {
        const urls = new Map(
            performance
                .getEntriesByType('resource')
                .map((entry) => [new URL(entry.name).pathname, entry.name]),
        )
        const probe = window.audioResilience
        probe.player = (await import(
            urls.get('/src/editor/player.ts') ?? '/src/editor/player.ts'
        )) as typeof import('../../src/editor/player')
        probe.audition = (await import(
            urls.get('/src/editor/audioPreview.ts') ?? '/src/editor/audioPreview.ts'
        )) as typeof import('../../src/editor/audioPreview')
        const { isPlaying } = (await import(
            urls.get('/src/player.ts') ?? '/src/player.ts'
        )) as typeof import('../../src/player')
        probe.isPlaying = () => isPlaying.value
        const { settings, history, fixtures, show, view, nextTick } = window.editorTest
        settings.playPreviewDuration = 0
        settings.playFollow = false
        settings.playStartPosition = 'cursor'
        settings.waveform = 'off'
        const note = fixtures.interaction.slides[0]![0]!
        show(
            {
                ...fixtures.interaction,
                slides: Array.from({ length: 120 }, (_, index) => [
                    { ...note, beat: 0.8 + index * 0.1 },
                ]),
            },
            3,
        )
        history.replaceState({
            ...history.state.value,
            bgm: {
                offset: 0,
                buffer: new AudioBuffer({
                    length: 15 * 48000,
                    sampleRate: 48000,
                    numberOfChannels: 1,
                }),
            },
        })
        view.cursorTime = 0
        await nextTick()
        await probe.context!.resume()
        probe.starts = []
        probe.stopped = []
        probe.ended = []
    })
})

test.afterEach(async ({ page }) => {
    const errors = await page.evaluate(() => {
        window.audioResilience.player?.stopPlayer(false)
        return window.audioResilience.errors
    })
    expect(errors, 'uncaught browser errors').toEqual([])
})

test('a delayed initial audio resume keeps the preview aligned with the BGM clock', async ({
    page,
}) => {
    await delayResume(page)
    await page.evaluate(() => window.audioResilience.player!.togglePreviewPlayback())
    await expect
        .poll(() => page.evaluate(() => window.audioResilience.resumeResolvedAt))
        .toBeDefined()
    const resumeTime = await page.evaluate(
        () => window.audioResilience.resumeResolvedAt! - window.audioResilience.resumeRequestedAt!,
    )
    expect(resumeTime).toBeGreaterThanOrEqual(290)
    await expect
        .poll(() => page.evaluate(() => window.editorTest.view.cursorTime))
        .toBeGreaterThan(0.35)
    await settle(page)
    const current = await snapshot(page)
    expect(current.playing).toBe(true)
    expect(current.bgmStarts).toBe(1)
    expect(Math.abs(current.cursor - current.audioPosition)).toBeLessThan(0.06)
})

test('audio-only suspension freezes the preview and resumes without a BGM restart or clock jump', async ({
    page,
}) => {
    await page.evaluate(() => window.audioResilience.player!.togglePreviewPlayback())
    await expect
        .poll(() => page.evaluate(() => window.editorTest.view.cursorTime))
        .toBeGreaterThan(0.3)
    await page.evaluate(() => window.audioResilience.context!.suspend())
    await settle(page)
    const suspended = await snapshot(page)
    await page.waitForTimeout(400)
    const waiting = await snapshot(page)
    expect(waiting.state).toBe('suspended')
    expect(waiting.playing).toBe(true)
    expect(waiting.audioTime).toBe(suspended.audioTime)
    expect(waiting.cursor).toBe(suspended.cursor)
    await page.evaluate(() => window.audioResilience.context!.resume())
    await expect
        .poll(() => page.evaluate(() => window.editorTest.view.cursorTime))
        .toBeGreaterThan(waiting.cursor + 0.2)
    await settle(page)
    const resumed = await snapshot(page)
    expect(resumed.bgmStarts).toBe(1)
    expect(Math.abs(resumed.cursor - resumed.audioPosition)).toBeLessThan(0.06)
})

test('changing playback speed continues at the audio position without another startup gap', async ({
    page,
}) => {
    await page.evaluate(() => window.audioResilience.player!.togglePreviewPlayback())
    await expect
        .poll(() => page.evaluate(() => window.editorTest.view.cursorTime))
        .toBeGreaterThan(0.4)
    const changed = await page.evaluate(() => {
        const probe = window.audioResilience
        const previous = probe.starts.find((source) => source.bgm)!
        probe.player!.changePlayerSpeed(1)
        const next = probe.starts.filter((source) => source.bgm).at(-1)!
        return { previous, next, stopped: probe.stopped }
    })
    expect(changed.next.id).not.toBe(changed.previous.id)
    expect(changed.next.rate).toBe(1.5)
    expect(changed.next.when - changed.next.contextTime).toBeLessThan(0.02)
    const continuousPosition =
        changed.previous.offset +
        (changed.next.when - changed.previous.when) * changed.previous.rate
    expect(Math.abs(changed.next.offset - continuousPosition)).toBeLessThan(0.02)
    expect(changed.stopped).toContain(changed.previous.id)
    await expect
        .poll(() => page.evaluate(() => window.editorTest.view.cursorTime))
        .toBeGreaterThan(changed.next.offset + 0.2)
    await settle(page)
    const current = await snapshot(page)
    expect(current.bgmStarts).toBe(2)
    expect(Math.abs(current.cursor - current.audioPosition)).toBeLessThan(0.06)
})

for (const milliseconds of [500, 1200]) {
    test(`${milliseconds} ms main-thread stalls preserve queued audio and recover without expired cue bursts`, async ({
        page,
    }) => {
        await page.evaluate(() => window.audioResilience.player!.togglePreviewPlayback())
        await expect
            .poll(() => page.evaluate(() => window.editorTest.view.cursorTime))
            .toBeGreaterThan(0.5)
        const stall = await page.evaluate((milliseconds) => {
            const context = window.audioResilience.context!
            const started = performance.now()
            const audioStart = context.currentTime
            while (performance.now() - started < milliseconds) {
                /* Deliberately block only the main thread. */
            }
            return { audioStart, audioEnd: context.currentTime, performanceEnd: performance.now() }
        }, milliseconds)
        expect(stall.audioEnd - stall.audioStart).toBeGreaterThan(milliseconds / 1000 - 0.1)
        await expect
            .poll(() =>
                page.evaluate(() => {
                    const { starts, context } = window.audioResilience
                    return starts.some(
                        (source) => !source.bgm && source.when > context!.currentTime + 0.3,
                    )
                }),
            )
            .toBe(true)
        await settle(page)
        const sources = await page.evaluate(() => ({
            starts: window.audioResilience.starts,
            stopped: window.audioResilience.stopped,
        }))
        const bgm = sources.starts.filter((source) => source.bgm)
        expect(bgm).toHaveLength(1)
        expect(sources.stopped).not.toContain(bgm[0]!.id)
        const cues = sources.starts.filter((source) => !source.bgm)
        const expected = Array.from(
            { length: 120 },
            (_, index) => bgm[0]!.when + 0.4 + index * 0.05,
        ).filter((when) => when > stall.audioStart + 0.075 && when < stall.audioEnd - 0.075)
        expect(expected.length).toBeGreaterThan(4)
        const missing = expected.filter(
            (when) => !cues.some((source) => Math.abs(source.when - when) < 0.00001),
        )
        if (milliseconds === 500) expect(missing).toEqual([])
        else expect(missing.length).toBeGreaterThan(0)
        for (const cue of cues.filter((source) => source.performanceTime >= stall.performanceEnd)) {
            expect(cue.when).toBeGreaterThanOrEqual(cue.contextTime - 0.005)
        }
        expect(new Set(cues.map((source) => source.when.toFixed(6))).size).toBe(cues.length)
        const current = await snapshot(page)
        expect(Math.abs(current.cursor - current.audioPosition)).toBeLessThan(0.06)
    })
}

test('pausing immediately after a stalled frame captures the audio position', async ({ page }) => {
    await page.evaluate(() => window.audioResilience.player!.togglePreviewPlayback())
    await expect
        .poll(() => page.evaluate(() => window.editorTest.view.cursorTime))
        .toBeGreaterThan(0.3)
    const paused = await page.evaluate(() => {
        const probe = window.audioResilience
        const before = window.editorTest.view.cursorTime
        const started = performance.now()
        while (performance.now() - started < 500) {
            /* Pause before the next visual frame can catch up. */
        }
        const bgm = probe.starts.find((source) => source.bgm)!
        const audioPosition = bgm.offset + (probe.context!.currentTime - bgm.when) * bgm.rate
        probe.player!.togglePreviewPlayback()
        return { before, audioPosition, cursor: window.editorTest.view.cursorTime }
    })
    expect(paused.cursor).toBeGreaterThan(paused.before + 0.4)
    expect(Math.abs(paused.cursor - paused.audioPosition)).toBeLessThan(0.02)
    await page.waitForTimeout(300)
    const current = await snapshot(page)
    expect(current.playing).toBe(false)
    expect(current.cursor).toBe(paused.cursor)
})

test('backgrounding cancels a queued audition before the audio flush', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { audition, starts } = window.audioResilience
        window.editorTest.settings.playPreviewDuration = 120
        audition!.requestAudioPreview(0.01)
        Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false })
        window.dispatchEvent(new Event('blur'))
        await window.editorTest.nextTick()
        return { sources: starts.length }
    })
    expect(result).toEqual({ sources: 0 })
    await page.evaluate(() => {
        Reflect.deleteProperty(document, 'hasFocus')
        window.dispatchEvent(new Event('focus'))
    })
    await settle(page)
    expect(await page.evaluate(() => window.audioResilience.starts)).toEqual([])
})

test('backgrounding cancels an audition whose audio resume is still pending', async ({ page }) => {
    await delayResume(page)
    const source = await page.evaluate(async () => {
        const probe = window.audioResilience
        window.editorTest.settings.playPreviewDuration = 120
        probe.audition!.requestAudioPreview(0.01)
        await window.editorTest.nextTick()
        return probe.starts[0]!
    })
    expect(source.bgm).toBe(true)
    await page.evaluate(() => {
        Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false })
        window.dispatchEvent(new Event('blur'))
    })
    await expect
        .poll(() => page.evaluate(() => window.audioResilience.resumeResolvedAt))
        .toBeDefined()
    await page.waitForTimeout(250)
    const result = await page.evaluate(() => ({
        starts: window.audioResilience.starts,
        stopped: window.audioResilience.stopped,
        cursor: window.editorTest.view.cursorTime,
    }))
    expect(result.starts).toHaveLength(1)
    expect(result.stopped).toContain(source.id)
    expect(result.cursor).toBe(0)
})

for (const action of ['pause', 'blur'] as const) {
    test(`${action} during pending resume cannot start late audio or advance the cursor`, async ({
        page,
    }) => {
        await delayResume(page)
        await page.evaluate(() => window.audioResilience.player!.togglePreviewPlayback())
        const stopped = await page.evaluate((action) => {
            const probe = window.audioResilience
            if (action === 'pause') probe.player!.stopPlayer(false)
            else {
                Object.defineProperty(document, 'hasFocus', {
                    configurable: true,
                    value: () => false,
                })
                window.dispatchEvent(new Event('blur'))
            }
            return { cursor: window.editorTest.view.cursorTime, sources: probe.starts.length }
        }, action)
        await expect
            .poll(() => page.evaluate(() => window.audioResilience.resumeResolvedAt))
            .toBeDefined()
        await page.waitForTimeout(400)
        const final = await snapshot(page)
        expect(final.playing).toBe(false)
        expect(final.cursor).toBe(stopped.cursor)
        const sources = await page.evaluate(() => ({
            starts: window.audioResilience.starts,
            stopped: window.audioResilience.stopped,
        }))
        expect(sources.starts).toHaveLength(stopped.sources)
        for (const source of sources.starts) expect(sources.stopped).toContain(source.id)
        if (action === 'blur') {
            await page.evaluate(() => {
                Reflect.deleteProperty(document, 'hasFocus')
                window.dispatchEvent(new Event('focus'))
            })
            await settle(page)
            expect((await snapshot(page)).playing).toBe(false)
        }
    })
}

test('a resume held through an interruption does not block the next Play', async ({ page }) => {
    // As WebKit does during an interruption, resume() neither starts nor rejects, and settles
    // once the context runs.
    await page.evaluate(async () => {
        const probe = window.audioResilience
        const context = probe.context!
        await context.suspend()
        const resume = context.resume.bind(context)
        const interruption = (probe.interruption = { active: true, resumes: 0 })
        context.resume = () => {
            interruption.resumes++
            if (!interruption.active) return resume()
            return new Promise<void>((resolve) => {
                const check = () => {
                    if (context.state !== 'running') return
                    context.removeEventListener('statechange', check)
                    resolve()
                }
                context.addEventListener('statechange', check)
            })
        }
        probe.player!.togglePreviewPlayback()
    })
    await settle(page)
    expect(await snapshot(page)).toMatchObject({ state: 'suspended', playing: true, cursor: 0 })
    // The interruption ends; Pause, then Play.
    await page.evaluate(() => {
        const probe = window.audioResilience
        probe.interruption!.active = false
        probe.player!.togglePreviewPlayback()
        probe.player!.togglePreviewPlayback()
    })
    await expect.poll(() => cursor(page)).toBeGreaterThan(0.3)
    const current = await snapshot(page)
    expect(current.playing).toBe(true)
    expect(Math.abs(current.cursor - current.audioPosition)).toBeLessThan(0.06)
    expect(await page.evaluate(() => window.audioResilience.interruption!.resumes)).toBe(2)
    expect(await contextCount(page)).toBe(1)
})

test('Play replaces an interrupted context and restarts the BGM from the same buffer', async ({
    page,
}) => {
    // WebKit's state while the audio session is interrupted.
    await page.evaluate(async () => {
        const context = window.audioResilience.context!
        await context.suspend()
        Object.defineProperty(context, 'state', { configurable: true, get: () => 'interrupted' })
        // The new context starts suspended, as WebKit's can, and runs once its resume() settles.
        const state = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, 'state')!.get!
        window.AudioContext = new Proxy(window.AudioContext, {
            construct(target, args) {
                const next = Reflect.construct(target, args) as AudioContext
                let resumed = false
                Object.defineProperty(next, 'state', {
                    configurable: true,
                    get: () => (resumed ? (state.call(next) as AudioContextState) : 'suspended'),
                })
                const resume = next.resume.bind(next)
                next.resume = async () => {
                    await new Promise((resolve) => setTimeout(resolve, 100))
                    await resume()
                    resumed = true
                    next.dispatchEvent(new Event('statechange'))
                }
                return next
            },
        })
    })
    await toggle(page)
    expect(await contextCount(page)).toBe(2)
    await expect.poll(() => cursor(page)).toBeGreaterThan(1.2)
    const result = await page.evaluate(() => {
        const { contexts, starts } = window.audioResilience
        Reflect.deleteProperty(contexts[0]!, 'state')
        return { closed: contexts[0]!.state === 'closed', starts }
    })
    expect(result.closed).toBe(true)
    const bgm = result.starts.filter((source) => source.bgm)
    expect(bgm).toHaveLength(1)
    expect(bgm[0]).toMatchObject({ context: 1, offset: 0 })
    // The new context's scheduler queues cues past the first window.
    expect(
        result.starts.some(
            (source) => !source.bgm && source.context === 1 && source.when > bgm[0]!.when + 1,
        ),
    ).toBe(true)
    const current = await snapshot(page)
    expect(Math.abs(current.cursor - current.audioPosition)).toBeLessThan(0.06)
})

test('a running context whose clock does not move stops Play, and the next Play uses a new context', async ({
    page,
}) => {
    await freezeClock(page)
    await toggle(page)
    expect(await isPlaying(page)).toBe(true)
    await untilStopped(page)
    await expect(notice(page, startFailed)).toBeVisible()
    expect(await cursor(page)).toBe(0)
    expect(await unstopped(page)).toEqual([])
    expect(await contextCount(page)).toBe(1)
    await toggle(page)
    expect(await contextCount(page)).toBe(2)
    await expect.poll(() => cursor(page)).toBeGreaterThan(0.3)
    const current = await snapshot(page)
    expect(current.playing).toBe(true)
    expect(Math.abs(current.cursor - current.audioPosition)).toBeLessThan(0.06)
})

test('a clock that stops during playback makes the next Play use a new context', async ({
    page,
}) => {
    await toggle(page)
    await expect.poll(() => cursor(page)).toBeGreaterThan(0.3)
    await freezeClock(page)
    await page.waitForTimeout(1500)
    expect(await isPlaying(page)).toBe(true)
    await toggle(page)
    const paused = await cursor(page)
    await toggle(page)
    expect(await contextCount(page)).toBe(2)
    await expect.poll(() => cursor(page)).toBeGreaterThan(paused + 0.3)
    const current = await snapshot(page)
    expect(current.playing).toBe(true)
    expect(Math.abs(current.cursor - current.audioPosition)).toBeLessThan(0.06)
    const bgm = await page.evaluate(() =>
        window.audioResilience.starts.filter((source) => source.bgm).at(-1),
    )
    expect(bgm!.context).toBe(1)
    expect(bgm!.offset).toBeCloseTo(paused, 6)
})

for (const withBgm of [true, false]) {
    test(`a resume that never settles stops Play ${withBgm ? 'with' : 'without'} BGM, and the next Play uses a new context`, async ({
        page,
    }) => {
        await page.evaluate(async (withBgm) => {
            const { history, nextTick } = window.editorTest
            if (!withBgm) {
                history.replaceState({ ...history.state.value, bgm: { offset: 0 } })
                await nextTick()
            }
            const context = window.audioResilience.context!
            await context.suspend()
            context.resume = () => new Promise<void>(() => {})
        }, withBgm)
        await toggle(page)
        expect(await isPlaying(page)).toBe(true)
        await untilStopped(page)
        await expect(notice(page, startFailed)).toBeVisible()
        expect(await cursor(page)).toBe(0)
        expect(await unstopped(page)).toEqual([])
        await toggle(page)
        expect(await contextCount(page)).toBe(2)
        await expect.poll(() => cursor(page)).toBeGreaterThan(0.3)
        const current = await snapshot(page)
        expect(current.playing).toBe(true)
        const starts = await page.evaluate(() => window.audioResilience.starts)
        expect(starts.some((source) => !source.bgm && source.context === 1)).toBe(true)
        if (withBgm) expect(Math.abs(current.cursor - current.audioPosition)).toBeLessThan(0.06)
        else expect(starts.some((source) => source.bgm)).toBe(false)
    })
}

test('a late rejection from an earlier Play leaves a newer Play running', async ({ page }) => {
    await page.evaluate(async () => {
        const probe = window.audioResilience
        const context = probe.context!
        await context.suspend()
        const resume = context.resume.bind(context)
        let calls = 0
        context.resume = async () => {
            const call = ++calls
            await new Promise((resolve) => setTimeout(resolve, call === 1 ? 200 : 500))
            if (call === 1) throw new DOMException('Resume failed', 'InvalidStateError')
            await resume()
            probe.resumeResolvedAt = performance.now()
        }
        // Play, Pause, then Play again while the first resume is still pending.
        probe.player!.togglePreviewPlayback()
        probe.player!.togglePreviewPlayback()
        probe.player!.togglePreviewPlayback()
    })
    await expect
        .poll(() => page.evaluate(() => window.audioResilience.resumeResolvedAt))
        .toBeDefined()
    await expect.poll(() => cursor(page)).toBeGreaterThan(0.3)
    const current = await snapshot(page)
    expect(current.playing).toBe(true)
    expect(current.bgmStarts).toBe(2)
    expect(Math.abs(current.cursor - current.audioPosition)).toBeLessThan(0.06)
    expect(await contextCount(page)).toBe(1)
    const sources = await page.evaluate(() => ({
        first: window.audioResilience.starts.find((source) => source.bgm)!.id,
        stopped: window.audioResilience.stopped,
    }))
    expect(sources.stopped).toContain(sources.first)
})

test('a Play whose resume is still pending past the deadline uses a new context', async ({
    page,
}) => {
    await page.evaluate(async () => {
        const { context, player } = window.audioResilience
        await context!.suspend()
        context!.resume = () => new Promise<void>(() => {})
        // Play, then Pause before the start deadline.
        player!.togglePreviewPlayback()
        player!.togglePreviewPlayback()
    })
    await page.waitForTimeout(3200)
    await toggle(page)
    expect(await contextCount(page)).toBe(2)
    await expect.poll(() => cursor(page)).toBeGreaterThan(0.3)
    const current = await snapshot(page)
    expect(current.playing).toBe(true)
    expect(Math.abs(current.cursor - current.audioPosition)).toBeLessThan(0.06)
})

test('an audition that has not started by the deadline never plays, even when the context runs later', async ({
    page,
}) => {
    await page.evaluate(async () => {
        const { context, audition } = window.audioResilience
        await context!.suspend()
        context!.resume = () => new Promise<void>(() => {})
        window.editorTest.settings.playPreviewDuration = 120
        audition!.requestAudioPreview(0.01)
    })
    await expect.poll(() => page.evaluate(() => window.audioResilience.starts.length)).toBe(1)
    const audition = await page.evaluate(() => window.audioResilience.starts[0]!.id)
    await expect
        .poll(() => page.evaluate(() => window.audioResilience.stopped), { timeout: 10_000 })
        .toContain(audition)
    // The context starts by itself, and once its clock moves Play keeps it.
    const stuck = await page.evaluate(async () => {
        const context = window.audioResilience.context!
        const time = context.currentTime
        await AudioContext.prototype.resume.call(context)
        return time
    })
    await expect
        .poll(() => page.evaluate(() => window.audioResilience.context!.currentTime))
        .toBeGreaterThan(stuck)
    await toggle(page)
    expect(await contextCount(page)).toBe(1)
    await expect.poll(() => cursor(page)).toBeGreaterThan(0.3)
    const current = await snapshot(page)
    expect(current.playing).toBe(true)
    expect(Math.abs(current.cursor - current.audioPosition)).toBeLessThan(0.06)
})

test('a resume that takes 1.3 s plays without a stop, on the same context', async ({ page }) => {
    await page.evaluate(async () => {
        const probe = window.audioResilience
        const context = probe.context!
        await context.suspend()
        const resume = context.resume.bind(context)
        context.resume = async () => {
            await new Promise((resolve) => setTimeout(resolve, 1300))
            await resume()
            probe.resumeResolvedAt = performance.now()
        }
        probe.player!.togglePreviewPlayback()
    })
    await expect
        .poll(() => page.evaluate(() => window.audioResilience.resumeResolvedAt))
        .toBeDefined()
    await expect.poll(() => cursor(page)).toBeGreaterThan(0.35)
    const current = await snapshot(page)
    expect(current.playing).toBe(true)
    expect(current.bgmStarts).toBe(1)
    expect(Math.abs(current.cursor - current.audioPosition)).toBeLessThan(0.06)
    expect(await contextCount(page)).toBe(1)
    const sources = await page.evaluate(() => ({
        bgm: window.audioResilience.starts.find((source) => source.bgm)!.id,
        stopped: window.audioResilience.stopped,
    }))
    expect(sources.stopped).not.toContain(sources.bgm)
})

test('a start slower than the deadline stops Play, and the next Play keeps the context once its clock moved', async ({
    page,
}) => {
    await page.evaluate(async () => {
        const probe = window.audioResilience
        const context = probe.context!
        await context.suspend()
        const resume = context.resume.bind(context)
        context.resume = async () => {
            await new Promise((resolve) => setTimeout(resolve, 3600))
            await resume()
            probe.resumeResolvedAt = performance.now()
        }
        probe.player!.togglePreviewPlayback()
    })
    await untilStopped(page)
    await expect(notice(page, startFailed)).toBeVisible()
    const stuck = await page.evaluate(() => window.audioResilience.context!.currentTime)
    await expect
        .poll(() => page.evaluate(() => window.audioResilience.resumeResolvedAt), {
            timeout: 10_000,
        })
        .toBeDefined()
    await expect
        .poll(() => page.evaluate(() => window.audioResilience.context!.currentTime))
        .toBeGreaterThan(stuck)
    await toggle(page)
    expect(await contextCount(page)).toBe(1)
    await expect.poll(() => cursor(page)).toBeGreaterThan(0.3)
    const current = await snapshot(page)
    expect(current.playing).toBe(true)
    expect(Math.abs(current.cursor - current.audioPosition)).toBeLessThan(0.06)
})

test('Play replaces a closed context', async ({ page }) => {
    await page.evaluate(() => window.audioResilience.context!.close())
    await toggle(page)
    expect(await contextCount(page)).toBe(2)
    await expect.poll(() => cursor(page)).toBeGreaterThan(0.3)
    const current = await snapshot(page)
    expect(current.playing).toBe(true)
    expect(Math.abs(current.cursor - current.audioPosition)).toBeLessThan(0.06)
})

test('a Play pressed right after a failed start, before the next frame, plays', async ({
    page,
}) => {
    await freezeClock(page)
    await toggle(page)
    // Pressed before any frame after the failed start.
    const retried = await page.evaluate(async () => {
        const { appImport } = window.editorTest
        const { watch } = await appImport<typeof import('../helpers/vue')>('/tests/helpers/vue.ts')
        const { isPlaying } = await appImport<typeof import('../../src/player')>('/src/player.ts')
        return new Promise<{ playing: boolean; contexts: number }>((resolve) => {
            // Runs in a microtask after the task that stopped playback.
            const stop = watch(isPlaying, (playing) => {
                if (playing) return
                stop()
                window.audioResilience.player!.togglePreviewPlayback()
                resolve({
                    playing: isPlaying.value,
                    contexts: window.audioResilience.contexts.length,
                })
            })
        })
    })
    expect(retried).toEqual({ playing: true, contexts: 2 })
    await expect.poll(() => cursor(page)).toBeGreaterThan(0.3)
    await expect(notice(page, 'Stopped playing')).toHaveCount(0)
})

test('a context replaced while it decodes audio is closed only once the decode settles', async ({
    page,
}) => {
    const result = await page.evaluate(
        async (bytes) => {
            const probe = window.audioResilience
            const context = probe.context!
            const { loadBgm } =
                await window.editorTest.appImport<typeof import('../../src/player')>(
                    '/src/player.ts',
                )
            let release!: () => void
            const held = new Promise<void>((resolve) => (release = resolve))
            const decode = context.decodeAudioData.bind(context)
            context.decodeAudioData = (async (data: ArrayBuffer) => {
                await held
                return decode(data)
            }) as typeof context.decodeAudioData
            const loading = loadBgm(new Uint8Array(bytes).buffer)
            await context.suspend()
            Object.defineProperty(context, 'state', {
                configurable: true,
                get: () => 'interrupted',
            })
            probe.player!.togglePreviewPlayback()
            await new Promise((resolve) => setTimeout(resolve, 200))
            const state = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, 'state')!.get!
            const whileDecoding = state.call(context) as AudioContextState
            release()
            const buffer = await loading
            return { contexts: probe.contexts.length, whileDecoding, duration: buffer.duration }
        },
        [...wav(0.5)],
    )
    expect(result.contexts).toBe(2)
    expect(result.whileDecoding).not.toBe('closed')
    expect(result.duration).toBeCloseTo(0.5, 2)
    await expect
        .poll(() =>
            page.evaluate(() => {
                const state = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, 'state')!
                return state.get!.call(window.audioResilience.contexts[0]!) as AudioContextState
            }),
        )
        .toBe('closed')
})

for (const event of ['visibilitychange', 'pageshow'] as const) {
    test(`after ${event}, playback stays paused and a clock that stopped meanwhile gets a new context at Play`, async ({
        page,
    }) => {
        const hide = () =>
            page.evaluate((event) => {
                Object.defineProperty(document, 'visibilityState', {
                    configurable: true,
                    value: 'hidden',
                })
                if (event === 'pageshow')
                    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))
                else document.dispatchEvent(new Event('visibilitychange'))
            }, event)
        const show = () =>
            page.evaluate((event) => {
                Reflect.deleteProperty(document, 'visibilityState')
                if (event === 'pageshow') {
                    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
                    window.dispatchEvent(new Event('focus'))
                } else document.dispatchEvent(new Event('visibilitychange'))
            }, event)
        const sourceCount = () => page.evaluate(() => window.audioResilience.starts.length)

        for (const stalled of [false, true]) {
            const before = await cursor(page)
            await toggle(page)
            await expect.poll(() => cursor(page)).toBeGreaterThan(before + 0.3)
            await hide()
            expect(await isPlaying(page)).toBe(false)
            if (stalled) await freezeClock(page)
            const sources = await sourceCount()
            await show()
            await page.waitForTimeout(700)
            expect(await isPlaying(page)).toBe(false)
            expect(await sourceCount()).toBe(sources)
            await settle(page)
            await toggle(page)
            expect(await contextCount(page)).toBe(stalled ? 2 : 1)
            const start = await cursor(page)
            await expect.poll(() => cursor(page)).toBeGreaterThan(start + 0.3)
            const current = await snapshot(page)
            expect(Math.abs(current.cursor - current.audioPosition)).toBeLessThan(0.06)
            await toggle(page)
        }
    })
}
