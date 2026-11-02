import assert from 'node:assert/strict'
import test from 'node:test'
import {
    clampRange,
    frameCount,
    lastObjectBeat,
    leadIn,
    openingRange,
    selectionRange,
    selectionSpan,
    setEnd,
    stripEndOf,
    wholeChartEnd,
    wholeRange,
    zoomSpan,
} from '../../src/editor/exportVideo/clipRange'
import { formatClipTime, parseClipTime, rulerStep } from '../../src/editor/exportVideo/clipTime'
import { videoFileName } from '../../src/editor/exportVideo/videoName'
import { estimateBytes, presetBitrate, qualityOf } from '../../src/exportVideo/estimate'
import { bgmEndOf } from '../../src/levelData/statistics'
import type { Bgm } from '../../src/state/bgm'
import { calculateBpms } from '../../src/state/integrals/bpms'

const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9)

test('whole chart ends one second after the last object', () => {
    assert.equal(wholeChartEnd(120), 121)
    assert.equal(wholeChartEnd(160), 161)
    assert.equal(wholeChartEnd(30), 31)
    // An empty stage can still be exported.
    assert.equal(wholeChartEnd(undefined), 10)
})

test('the strip leaves room after both the chart and BGM', () => {
    close(stripEndOf(121, 151.2), 151.2 * 1.05)
    close(stripEndOf(161, 151.2), 161 * 1.05)
    close(stripEndOf(10), 12)
})

for (const lastObject of [120, 160])
    test(`Whole BGM defaults to the music end with the last object at ${lastObject}`, () => {
        const bgmEnd = bgmEndOf({ offset: 0.25, buffer: { duration: 151.46 } } as Bgm)
        const wholeEnd = wholeChartEnd(lastObject)
        const initial = openingRange(undefined, wholeEnd, bgmEnd, 30)
        assert.equal(initial.kind, 'bgm')
        assert.equal(initial.range.in, 0)
        close(initial.range.out, 4537 / 30)
        assert.deepEqual(
            openingRange({ kind: 'whole', range: initial.range }, wholeEnd, bgmEnd, 30),
            { kind: 'whole', range: { in: 0, out: lastObject + 1 } },
        )
    })

for (const [name, bgm] of [
    ['no BGM', { offset: 0 }],
    [
        'a BGM with no known length',
        { offset: 0, meta: { hash: 'music', filename: 'music.ogg', size: 100, type: 'audio/ogg' } },
    ],
] as const)
    test(`Whole Chart is the default with ${name}`, () => {
        const end = bgmEndOf(bgm)
        assert.equal(end, undefined)
        assert.deepEqual(openingRange(undefined, wholeChartEnd(30), end, 30), {
            kind: 'whole',
            range: { in: 0, out: 31 },
        })
    })

test('a remembered Whole BGM uses Whole Chart after the BGM is removed', () => {
    const remembered = { kind: 'bgm' as const, range: { in: 0, out: 200 } }
    assert.deepEqual(openingRange(remembered, wholeChartEnd(30), undefined, 30), {
        kind: 'whole',
        range: { in: 0, out: 31 },
    })
    assert.deepEqual(openingRange(remembered, wholeChartEnd(30), 60, 30), {
        kind: 'bgm',
        range: { in: 0, out: 60 },
    })
    assert.deepEqual(openingRange({ ...remembered, kind: 'custom' }, 31, undefined, 30), {
        kind: 'custom',
        range: { in: 0, out: 33 },
    })
})

test('frames are whole: In inclusive, Out exclusive, and a frame rate change keeps the ends', () => {
    assert.equal(frameCount({ in: 12.5, out: 105 }, 30), 2775)
    assert.equal(frameCount({ in: 12.5, out: 105 }, 60), 5550)
    // An off-grid range rounds up, so the last frame is kept.
    assert.equal(frameCount({ in: 0, out: 1 / 60 }, 30), 1)
    // Rounding noise does not add a frame.
    assert.equal(frameCount({ in: 0.1, out: 0.1 + 3 / 30 }, 30), 3)
    const whole = wholeRange(151.21, 30)
    assert.equal(whole.in, 0)
    close(whole.out, 4537 / 30)
})

test('selection takes the lead-in at its note speed and the lead-out', () => {
    const strip = stripEndOf(200)
    const slow = selectionRange({ first: 60, last: 70 }, 1, strip, 30)
    const fast = selectionRange({ first: 60, last: 70 }, 12, strip, 30)
    assert.ok(slow.in < fast.in)
    close(fast.in, Math.floor((60 - leadIn(12)) * 30 + 1e-6) / 30)
    close(slow.out, 71)
    // In is clamped at 0, and an event after the last note still fits the strip.
    assert.equal(selectionRange({ first: 1, last: 2 }, 6, strip, 30).in, 0)
})

test('limits: within the strip and at least one frame', () => {
    const strip = 20
    assert.deepEqual(clampRange({ in: -1, out: 30 }, strip, 30), { in: 0, out: 20 })
    const short = clampRange({ in: 5, out: 5 }, strip, 30)
    close(short.out - short.in, 1 / 30)
    const end = clampRange({ in: 25, out: 26 }, strip, 30)
    close(end.out, 20)
    close(end.in, 20 - 1 / 30)
})

test('setting an end past the other moves the other to keep one frame', () => {
    const range = { in: 10, out: 20 }
    const pushed = setEnd(range, 'in', 25, 100, 30)
    close(pushed.in, 25)
    close(pushed.out, 25 + 1 / 30)
    const pulled = setEnd(range, 'out', 5, 100, 30)
    close(pulled.out, 5)
    close(pulled.in, 5 - 1 / 30)
    // The playhead time snaps to the grid.
    close(setEnd(range, 'in', 12.01, 100, 30).in, 12)
})

test('zoom maps the range with 10 % a side, at least 4 s, inside the strip', () => {
    assert.deepEqual(zoomSpan({ in: 10, out: 20 }, 100), [9, 21])
    assert.deepEqual(zoomSpan({ in: 10, out: 11 }, 100), [8.5, 12.5])
    assert.deepEqual(zoomSpan({ in: 0, out: 1 }, 100), [0, 4])
    assert.deepEqual(zoomSpan({ in: 99, out: 100 }, 100), [96, 100])
})

test('clip times are written and read', () => {
    assert.equal(formatClipTime(83.456), '01:23.456')
    assert.equal(formatClipTime(59.9996), '01:00.000')
    assert.equal(formatClipTime(5531.2, true), '1:32:11.200')
    assert.equal(formatClipTime(12.5, true), '0:00:12.500')
    assert.equal(parseClipTime('01:23.456'), 83.456)
    assert.equal(parseClipTime('1:32:11.2'), 5531.2)
    assert.equal(parseClipTime('12,5'), 12.5)
    assert.equal(parseClipTime(' 90 '), 90)
    for (const bad of ['', 'a', '1:2:3:4', '1.5:20', '1::2', '-3']) {
        assert.equal(parseClipTime(bad), undefined, bad)
    }
})

test('the ruler keeps labels 64 px apart', () => {
    assert.equal(rulerStep(100), 1)
    assert.equal(rulerStep(5), 15)
    assert.equal(rulerStep(0.1), 900)
    assert.equal(rulerStep(0.01), 7200)
})

test('file names: the whole chart, a clip, tenths under 10 s, and no stem', () => {
    assert.equal(videoFileName('coconut', undefined, 'mp4'), 'coconut.mp4')
    assert.equal(
        videoFileName('coconut', { in: 83.4, out: 105.2 }, 'webm'),
        'coconut 1m23s-1m46s.webm',
    )
    assert.equal(
        videoFileName('coconut', { in: 5.55, out: 8.96 }, 'mp4'),
        'coconut 0m05.5s-0m09.0s.mp4',
    )
    assert.equal(videoFileName('', undefined, 'mp4'), 'Video.mp4')
})

test('presets follow the table, scale by width, and a typed bitrate is custom', () => {
    assert.equal(presetBitrate('standard', 1080, 30, 1920), 8e6)
    assert.equal(presetBitrate('high', 1080, 60, 1920), 18e6)
    assert.equal(presetBitrate('low', 720, 30, 1280), 2.5e6)
    assert.equal(presetBitrate('standard', 2160, 30, 3840), 36e6)
    assert.equal(presetBitrate('standard', 1080, 30, 2520), 10.5e6)
    assert.equal(qualityOf(12e6, 1080, 60, 1920), 'standard')
    assert.equal(qualityOf(9e6, 1080, 30, 1920), 'custom')
})

test('size estimate', () => {
    // The 92.5 s example at 1080p30 Standard with 192 kbps audio is about 96.7 MB.
    assert.equal(Math.round(estimateBytes(92.5, 8e6, 192e3) / 1e5) / 10, 96.7)
    assert.equal(estimateBytes(10, 8e6, 0), ((10 * 8e6) / 8) * 1.02 + 64_000)
})

test('the last object counts notes and events, and a selection counts connector tails', () => {
    type Grid = Map<number, Set<{ type: string; beat: number }>>
    const grid = (entries: { type: string; beat: number }[]): Grid => {
        const map: Grid = new Map()
        for (const entity of entries) {
            const key = Math.floor(entity.beat)
            map.set(key, (map.get(key) ?? new Set()).add(entity))
        }
        return map
    }
    const store = {
        grid: {
            note: grid([
                { type: 'note', beat: 4 },
                { type: 'note', beat: 8.5 },
            ]),
            cameraEventJoint: grid([{ type: 'cameraEventJoint', beat: 12 }]),
            bpm: grid([{ type: 'bpm', beat: 40 }]),
            timeScale: grid([{ type: 'timeScale', beat: 30 }]),
        },
    }
    assert.equal(lastObjectBeat({ store } as never), 12)
    const bpms = calculateBpms([{ x: 0, y: 0, s: 1 }])
    const head = { type: 'note', beat: 2 }
    const tail = { type: 'note', beat: 6 }
    assert.deepEqual(
        selectionSpan([{ type: 'connector', beat: 2, head, tail } as never, head as never], bpms),
        { first: 2, last: 6 },
    )
    assert.equal(selectionSpan([], bpms), undefined)
})
