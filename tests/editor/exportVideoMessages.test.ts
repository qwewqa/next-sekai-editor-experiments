import assert from 'node:assert/strict'
import test from 'node:test'
import type { Outcome } from '../../src/editor/exportVideo/dialog'
import type { MessageInput } from '../../src/editor/exportVideo/messages'
import type { CodecSupport } from '../../src/exportVideo/codecs'
import type { GraphicsLimits } from '../../src/exportVideo/graphics'
import type { ExportWarning } from '../../src/exportVideo/warnings'
import './saveMatrix/env'

const { exportMessages } = await import('../../src/editor/exportVideo/messages')
const { describeVideoFailure } = await import('../../src/editor/exportVideo/failure')
const { AudioFailure } = await import('../../src/exportVideo/error')
const { settings } = await import('../../src/settings')

const works = { supported: true, format: 'mp4', video: { codec: 'avc1.640028' } } as CodecSupport
const refused: CodecSupport = { supported: false, reason: 'audioConfig' }
const limits = (size: number, renderbuffer = size): GraphicsLimits => ({
    viewport: [size, size],
    renderbuffer,
    texture: size,
})

const input = (patch: Partial<MessageInput> = {}): MessageInput => ({
    phase: 'setup',
    coarse: false,
    form: {
        aspect: 16 / 9,
        resolution: 1080,
        frameRate: 30,
        format: 'automatic',
        audioBitrate: 192_000,
        bgm: true,
        sfx: true,
        antialias: true,
        renderScale: 1,
    },
    support: { current: works, choices: {} },
    limits: limits(16384),
    frames: 300,
    bytes: 1_000_000,
    memoryRoute: false,
    stopped: null,
    storageNearlyFull: false,
    ...patch,
})
const form = (patch: Partial<MessageInput['form']>) => ({ ...input().form, ...patch })
/** Each message as the slot shows it: the field's name and colon, then the text. */
const lines = (state: MessageInput) =>
    exportMessages(state).map(({ label, text }) => (label ? `${label}: ${text}` : text))
const kinds = (state: MessageInput) => exportMessages(state).map(({ kind }) => kind)

const asked = { width: 1920, height: 1080, bgm: true, sfx: true, bytes: 1_000_000 }
const ready = (
    warnings: ExportWarning[],
    patch: Partial<Extract<Outcome, { kind: 'ready' }>> = {},
): Outcome => ({
    kind: 'ready',
    size: 1,
    delivered: false,
    shareable: false,
    warnings,
    asked,
    hidden: false,
    ...patch,
})

test('a refused audio bitrate suggests the nearest lower one, with Advanced open or folded', () => {
    // Every choice is probed at 256 kbps, so only the audio bitrate's own lower values pass.
    const choices: Record<string, CodecSupport> = {
        'resolution:720': refused,
        'frameRate:30': refused,
        'format:webm': refused,
        'audioBitrate:128000': works,
        'audioBitrate:192000': works,
        'sound:off': works,
    }
    const state = input({
        form: form({ audioBitrate: 256_000, frameRate: 60 }),
        support: { current: refused, choices },
    })
    for (const advanced of [false, true]) {
        settings.exportVideoAdvanced = advanced
        assert.deepEqual(lines(state), ['Audio Bitrate: Choose 192 kbps.'])
        assert.equal(exportMessages(state)[0]?.field, 'audioBitrate')
    }
    // A missing result is not evidence that a choice works; sound off is the last resort.
    assert.deepEqual(
        lines(input({ form: form({ format: 'mp4' }), support: { current: refused, choices: {} } })),
        [],
    )
    assert.deepEqual(
        lines(input({ support: { current: refused, choices: { 'sound:off': works } } })),
        ['Sound is unavailable in this browser with these settings. Turn off BGM and SFX.'],
    )
    assert.deepEqual(
        lines(
            input({
                form: form({ sfx: false, format: 'mp4' }),
                support: {
                    current: refused,
                    choices: { 'format:webm': works, 'sound:off': works },
                },
            }),
        ),
        ['Format: Choose WebM.'],
    )
})

test('the size check suggests Antialiasing off, then a lower Render Scale, then a lower Resolution', () => {
    const at2160 = (patch: Partial<MessageInput['form']>, known: GraphicsLimits) =>
        lines(input({ form: form({ resolution: 2160, ...patch }), limits: known }))
    // 7680 px wide at 2x: within the viewport, past the antialiasing renderbuffer.
    assert.deepEqual(at2160({ renderScale: 2 }, limits(8192, 4096)), [
        'Antialiasing is unavailable on this device with these settings. Turn it off.',
    ])
    assert.deepEqual(at2160({ renderScale: 2, antialias: false }, limits(4096)), [
        'Render Scale: Choose 1x.',
    ])
    assert.deepEqual(at2160({ antialias: false }, limits(2048)), ['Resolution: Choose 1080p.'])
    // With the codec check passing, a size its probes refused is passed over.
    assert.deepEqual(
        lines(
            input({
                form: form({ resolution: 2160, antialias: false }),
                limits: limits(3000),
                support: { current: works, choices: { 'resolution:1440': refused } },
            }),
        ),
        ['Resolution: Choose 1080p.'],
    )
})

test('both checks failing give both suggestions, codec first, and one when both name Resolution', () => {
    // Every size is refused at 256 kbps, and 2160p is past the limits: the size suggestion stays
    // disabled until the bitrate changes.
    const choices: Record<string, CodecSupport> = {
        'resolution:720': refused,
        'resolution:1080': refused,
        'resolution:1440': refused,
        'audioBitrate:192000': works,
    }
    assert.deepEqual(
        lines(
            input({
                form: form({ resolution: 2160, antialias: false, audioBitrate: 256_000 }),
                limits: limits(2048),
                support: { current: refused, choices },
            }),
        ),
        ['Audio Bitrate: Choose 192 kbps.', 'Resolution: Choose 1080p.'],
    )
    // The size check alone would take 1440p, which the codec refused; the codec's 1080p fits both.
    assert.deepEqual(
        lines(
            input({
                form: form({ resolution: 2160, antialias: false }),
                limits: limits(3000),
                support: {
                    current: refused,
                    choices: { 'resolution:1440': refused, 'resolution:1080': works },
                },
            }),
        ),
        ['Resolution: Choose 1080p.'],
    )
})

test('unknown limits give no size suggestion and do not stop the memory warning', () => {
    const state = input({
        form: form({ resolution: 2160, renderScale: 2 }),
        limits: null,
        memoryRoute: true,
        bytes: 200_000_000,
    })
    assert.deepEqual(kinds(state), ['memory'])
    // Until the limits are read, the settings are not known to work.
    assert.deepEqual(kinds({ ...state, limits: undefined }), [])
})

test('the memory warning needs the memory route, working settings and more than 150,000,000 bytes', () => {
    const state = input({ memoryRoute: true, bytes: 150_000_001, storageNearlyFull: true })
    assert.deepEqual(lines(state), [
        'Exporting with these settings may use too much memory. Choose a shorter range or lower the quality.',
    ])
    assert.deepEqual(kinds({ ...state, bytes: 150_000_000 }), [])
    assert.deepEqual(kinds({ ...state, memoryRoute: undefined }), ['storage'])
    assert.deepEqual(kinds({ ...state, frames: 0 }), [])
    // An update in progress keeps the settled result, so the warning stays until it settles.
    const pending = { ...state.support, pending: true }
    assert.deepEqual(kinds({ ...state, support: pending }), ['memory'])
    // Suggestions take its place while a check fails.
    const failing = { current: refused, choices: { 'audioBitrate:128000': works } }
    assert.deepEqual(kinds({ ...state, support: failing }), ['suggestion'])
    const failingPending = { ...failing, pending: true }
    assert.deepEqual(kinds({ ...state, support: failingPending }), ['suggestion'])
})

test('Setup shows advice, then the stopped line, then the storage warning off the memory route', () => {
    const stopped = { resolution: 2160, renderScale: 2 }
    assert.deepEqual(lines(input({ stopped, storageNearlyFull: true })), [
        'The last export at 2160p with 2x Render Scale did not finish.',
    ])
    assert.deepEqual(kinds(input({ stopped, memoryRoute: true, bytes: 2e8 })), ['memory'])
    assert.deepEqual(lines(input({ storageNearlyFull: true })), ['Browser storage is almost full.'])
    assert.deepEqual(kinds(input({ storageNearlyFull: true, memoryRoute: true })), [])
    // While busy, only the line about the tab; Finishing and Canceling show nothing.
    const busy = { support: { current: refused, choices: { 'sound:off': works } }, stopped }
    assert.deepEqual(lines(input({ ...busy, phase: 'exporting', coarse: true })), [
        'Keep this tab open and visible until the export finishes.',
    ])
    assert.deepEqual(lines(input({ ...busy, phase: 'preparing' })), [
        'Keep this tab open until the export finishes.',
    ])
    assert.deepEqual(kinds(input({ ...busy, phase: 'finishing' })), [])
    assert.deepEqual(kinds(input({ ...busy, phase: 'cancelling' })), [])
})

test('finished warnings keep their order and suppression, and compare with what the attempt asked for', () => {
    const all: ExportWarning[] = [
        { code: 'soundStopped', at: 3 },
        { code: 'audioSyncEstimated' },
        { code: 'resolutionDiffers', width: 1920, height: 1088 },
        { code: 'framesIncomplete', count: 2 },
        { code: 'timingReassigned', count: 1 },
        { code: 'framesMissing', count: 4 },
        { code: 'pictureStopped', at: 2 },
    ]
    // The form has moved on to 720p; the warning compares with what the attempt asked for.
    const state = input({ phase: 'ready', outcome: ready(all), form: form({ resolution: 720 }) })
    assert.deepEqual(lines(state), [
        'The picture stops before the end of the range.',
        'Some frames may be incomplete.',
        'The video is 1920 × 1088. The selected resolution was 1920 × 1080.',
        'The picture and sound may be out of sync.',
        'The sound stops before the end of the range.',
    ])
    // Without sound, reassigned timing is uneven motion.
    const silent = ready(
        [
            { code: 'timingReassigned', count: 1 },
            { code: 'framesMissing', count: 4 },
        ],
        { asked: { ...asked, bgm: false, sfx: false } },
    )
    assert.deepEqual(lines(input({ phase: 'ready', outcome: silent })), [
        'The picture may pause or end early.',
        'The motion may be uneven.',
    ])
    // Done shows the same warnings and nothing about the next export.
    const done: Outcome = { kind: 'done', name: 'clip.mp4', warnings: all, asked, hidden: false }
    assert.deepEqual(
        kinds(
            input({
                phase: 'done',
                outcome: done,
                memoryRoute: true,
                bytes: 2e8,
                storageNearlyFull: true,
            }),
        ),
        ['finished', 'finished', 'finished', 'finished', 'finished'],
    )
})

test('a picture that stopped while the page was hidden is followed by the advice to keep it visible', () => {
    const stopped: ExportWarning[] = [
        { code: 'pictureStopped', at: 2 },
        { code: 'soundStopped', at: 3 },
    ]
    const shown = exportMessages(
        input({ phase: 'ready', outcome: ready(stopped, { hidden: true }) }),
    )
    assert.deepEqual(
        shown.map(({ severity, text }) => [severity, text]),
        [
            ['warning', 'The picture stops before the end of the range.'],
            ['info', 'Keep this tab open and visible until the export finishes.'],
            ['warning', 'The sound stops before the end of the range.'],
        ],
    )
    // Not for a visible page, nor for missing frames alone.
    assert.equal(lines(input({ phase: 'ready', outcome: ready(stopped) })).length, 2)
    const missing = ready([{ code: 'framesMissing', count: 1 }], { hidden: true })
    assert.deepEqual(lines(input({ phase: 'ready', outcome: missing })), [
        'The picture may pause or end early.',
    ])
})

test('Ready keeps the warnings through a failed delivery and adds the memory warning for the next export', () => {
    const outcome = ready([{ code: 'framesIncomplete', count: 1 }])
    const state = input({ phase: 'ready', outcome, deliverFailed: 'download' })
    assert.deepEqual(lines(state), [
        'The video could not be downloaded.',
        'Some frames may be incomplete.',
    ])
    // The range grew past the line while the file waits.
    assert.deepEqual(kinds({ ...state, memoryRoute: true, bytes: 2e8 }), [
        'delivery',
        'finished',
        'memory',
    ])
    // Storage is mentioned only when nothing else shows.
    assert.deepEqual(kinds({ ...state, storageNearlyFull: true }), ['delivery', 'finished'])
    assert.deepEqual(
        kinds(input({ phase: 'ready', outcome: ready([]), storageNearlyFull: true })),
        ['storage'],
    )
})

test('Ready warns about memory only for an estimate above that of its own file', () => {
    const outcome = ready([], { asked: { ...asked, bytes: 2e8 } })
    const state = input({ phase: 'ready', outcome, memoryRoute: true, bytes: 2e8 })
    assert.deepEqual(kinds(state), [])
    assert.deepEqual(kinds({ ...state, bytes: 2e8 + 1 }), ['memory'])
    // Setup has no file, so the line alone decides.
    assert.deepEqual(kinds({ ...state, phase: 'setup', outcome: undefined }), ['memory'])
})

test('a failure is followed by the memory warning, except a memory failure', async () => {
    const state = (error: unknown) =>
        describeVideoFailure(error, 'clip.mp4', { bgm: true, sfx: false }).then((failure) =>
            input({
                phase: 'failed',
                outcome: { kind: 'failed', failure },
                memoryRoute: true,
                bytes: 2e8,
                storageNearlyFull: true,
            }),
        )
    assert.deepEqual(kinds(await state(new Error('Encoding failed'))), ['failure', 'memory'])
    assert.deepEqual(kinds(await state(new RangeError('Array buffer allocation failed'))), [
        'failure',
    ])
    const sound = exportMessages(
        await state(new AudioFailure(new DOMException('Encoding failed', 'EncodingError'))),
    )
    assert.equal(sound[0]?.text, 'The sound could not be created. Try again, or turn off BGM.')
    assert.equal(sound[0]?.detail, 'AudioFailure: Encoding failed')
})
