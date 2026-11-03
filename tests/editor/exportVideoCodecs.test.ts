import assert from 'node:assert/strict'
import test from 'node:test'
import {
    browserEncoderProbes,
    createCodecAvailability,
    createCodecProbes,
    createSharedWork,
    h264Level,
    h264Levels,
    outputSize,
    type CodecSettings,
} from '../../src/exportVideo/codecs'
import { usableTrial, type TrialOutput } from '../../src/exportVideo/worker/trial'

const settings: CodecSettings = {
    format: 'automatic',
    width: 1920,
    height: 1080,
    frameRate: 60,
    videoBitrate: 12e6,
    audioBitrate: 192000,
    bgm: true,
    sfx: true,
}

test('H.264 meets frame size, each dimension, processing rate and profile bitrate together', () => {
    assert.equal(h264Level({ ...settings, width: 2520, frameRate: 30 }, 'high'), 50)
    for (const [height, at30, at60] of [
        [720, 32, 42],
        [1080, 50, 51],
        [1440, 50, 52],
        [2160, 60, 60],
    ] as const) {
        const size = outputSize(height, 21 / 9)
        assert.equal(h264Level({ ...settings, ...size, frameRate: 30 }, 'high'), at30)
        assert.equal(h264Level({ ...settings, ...size }, 'high'), at60)
    }
    assert.equal(h264Level({ ...settings, width: 4096, height: 16, frameRate: 30 }, 'main'), 40)
    assert.equal(h264Level({ ...settings, frameRate: 30, videoBitrate: 25e6 }, 'high'), 40)
    assert.equal(h264Level({ ...settings, frameRate: 30, videoBitrate: 25e6 }, 'main'), 41)
    assert.deepEqual(
        h264Levels.filter(([l]) => [40, 41, 42, 50].includes(l)).map(([, , fs]) => fs),
        [8192, 8192, 8704, 22080],
    )
})

test('H.264 tries High, Main and Baseline before WebM and never drops selected sound', async () => {
    const calls: string[] = []
    const probes = createCodecProbes({
        video: async (c) => {
            calls.push(c.codec)
            return { supported: c.codec.startsWith('avc1.42') }
        },
        audio: async () => ({ supported: true }),
    })
    const result = await probes.resolve(settings)
    assert.equal(result.supported && result.format, 'mp4')
    assert.deepEqual(
        calls.map((c) => c.slice(0, 7)),
        ['avc1.64', 'avc1.4d', 'avc1.42'],
    )
    const audioFallback = createCodecProbes({
        video: async () => ({ supported: true }),
        audio: async (c) => ({ supported: c.codec === 'opus' }),
    })
    const fallback = await audioFallback.resolve(settings)
    assert.equal(fallback.supported && fallback.format, 'webm')
    assert.equal(fallback.supported && fallback.audio?.codec, 'opus')
    assert.deepEqual(await audioFallback.resolve({ ...settings, format: 'mp4' }), {
        supported: false,
        reason: 'audioConfig',
    })
})

test('a browser without AudioEncoder supports only an explicitly silent choice', async () => {
    const probes = createCodecProbes({ video: async () => ({ supported: true }) })
    assert.deepEqual(await probes.resolve(settings), { supported: false, reason: 'audioEncoder' })
    const silent = await probes.resolve({ ...settings, bgm: false, sfx: false })
    assert.equal(silent.supported && silent.format, 'mp4')
    assert.equal(silent.supported && silent.audio, undefined)
    assert.deepEqual(await createCodecProbes({}).resolve(settings), {
        supported: false,
        reason: 'videoEncoder',
    })
})

test('all dependent choices follow bitrate, aspect and MP4 to WebM to MP4 changes', async () => {
    const videos: VideoEncoderConfig[] = []
    const audios: AudioEncoderConfig[] = []
    const probes = createCodecProbes({
        video: async (c) => {
            videos.push(c)
            return { supported: c.width <= 1920 || c.codec.startsWith('vp09') }
        },
        audio: async (c) => {
            audios.push(c)
            return { supported: c.codec === 'opus' || c.bitrate !== 256000 }
        },
    })
    const availability = createCodecAvailability(probes)
    const choices = { audio256: { audioBitrate: 256000 }, wide: { width: 2520 } }
    for (const format of ['mp4', 'webm', 'mp4'] as const) {
        const pending = availability.update({ ...settings, format }, choices)
        assert.equal(availability.state.pending, true)
        assert.equal(availability.state.current, undefined)
        await pending
        assert.equal(availability.state.choices.audio256?.supported, format === 'webm')
    }
    for (const patch of [{ audioBitrate: 256000 }, { width: 2520 }]) {
        await availability.update({ ...settings, ...patch }, choices)
        assert.equal(
            availability.state.current?.supported && availability.state.current.format,
            'webm',
        )
    }
    const count = videos.length + audios.length
    await availability.update(settings, choices)
    assert.equal(videos.length + audios.length, count)
    for (const patch of [{ height: 720 }, { frameRate: 30 as const }, { videoBitrate: 20e6 }])
        await probes.resolve({ ...settings, ...patch })
    assert.ok(videos.some((c) => c.height === 720))
    assert.ok(videos.some((c) => c.framerate === 30))
    assert.ok(videos.some((c) => c.bitrate === 20e6))
    assert.ok(audios.some((c) => c.bitrate === 256000))
})

test('late support results never enable an obsolete selection', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
        release = resolve
    })
    const availability = createCodecAvailability(
        createCodecProbes({
            video: async (c) => {
                if (c.width === 1920) await held
                return { supported: true }
            },
        }),
    )
    const old = availability.update({ ...settings, bgm: false, sfx: false }, {})
    await availability.update({ ...settings, width: 2520, bgm: false, sfx: false }, {})
    release()
    await old
    assert.equal(
        availability.state.current?.supported && availability.state.current.video.width,
        2520,
    )
})

test('WebKit is offered only Constrained Baseline for MP4', async () => {
    const offered = async (engine: 'webkit' | 'chromium' | 'firefox') => {
        const codecs: string[] = []
        await createCodecProbes(
            {
                video: async (c) => {
                    codecs.push(c.codec)
                    return { supported: false }
                },
            },
            engine,
        ).resolve({ ...settings, format: 'mp4', bgm: false, sfx: false })
        return codecs
    }
    assert.deepEqual(await offered('webkit'), ['avc1.42402a'])
    for (const engine of ['chromium', 'firefox'] as const)
        assert.deepEqual(await offered(engine), ['avc1.64002a', 'avc1.4d002a', 'avc1.42002a'])
})

// Chromium's 320 by 180 H.264 configuration record: High profile, coded as 320 by 192 and
// cropped, with an SPS that has no colour fields.
const avcC = new Uint8Array([
    1, 100, 0, 30, 255, 225, 0, 23, 103, 100, 0, 30, 172, 43, 64, 160, 207, 207, 128, 136, 0, 0, 31,
    64, 0, 7, 83, 0, 120, 225, 53, 1, 0, 4, 104, 238, 60, 176, 253, 248, 248, 0,
])
const colorSpace = {
    primaries: 'bt709',
    transfer: 'iec61966-2-1',
    matrix: 'bt709',
    fullRange: true,
} as const
const encoded = (
    type: EncodedVideoChunkType,
    timestamp: number,
    duration: number | null,
    data: Uint8Array,
): EncodedVideoChunk => ({
    type,
    timestamp,
    duration,
    byteLength: data.length,
    copyTo: (target) => {
        new Uint8Array((target as Uint8Array).buffer).set(data)
    },
})

test('a trial accepts output the export can mux, in encoded order and without durations', async () => {
    const config = { codec: 'avc1.64001e', width: 320, height: 180, framerate: 30 as const }
    const vp9 = { ...config, codec: 'vp09.00.31.08' }
    const at = (i: number) => Math.round((i * 1e6) / 30)
    const avc = (
        order = [0, 1, 2],
        decoder: Partial<VideoDecoderConfig> | undefined = {},
        on = 0,
    ): TrialOutput[] =>
        order.map((frame, i) => ({
            chunk: encoded(
                i ? 'delta' : 'key',
                at(frame),
                at(frame + 1) - at(frame),
                new Uint8Array([0, 0, 0, 2, i ? 0x41 : 0x65, 0x88]),
            ),
            metadata:
                i === on && decoder
                    ? {
                          decoderConfig: {
                              codec: config.codec,
                              // Padded to whole macroblocks; the SPS crops to 180.
                              codedWidth: 320,
                              codedHeight: 192,
                              description: avcC,
                              colorSpace,
                              ...decoder,
                          },
                      }
                    : undefined,
        }))
    const webm = (decoder: boolean): TrialOutput[] =>
        [0, 1, 2].map((i) => ({
            chunk: encoded(
                i ? 'delta' : 'key',
                at(i),
                at(i + 1) - at(i),
                new Uint8Array([0x82, i]),
            ),
            metadata:
                decoder && !i
                    ? { decoderConfig: { codec: vp9.codec, codedWidth: 320, codedHeight: 180 } }
                    : undefined,
        }))
    assert.equal(await usableTrial(config, avc(), 3), true)
    assert.equal(await usableTrial(vp9, webm(true), 3), true)
    assert.equal(await usableTrial(vp9, webm(false), 3), false)
    // Presentation order differs from encoded order with B-frames.
    assert.equal(await usableTrial(config, avc([0, 2, 1]), 3), true)
    // Firefox's High and Main output is one frame late: the last chunk matches no frame.
    assert.equal(await usableTrial(config, avc([1, 2, 3]), 3), false)
    assert.equal(await usableTrial(config, avc([0, 1]), 3), false)
    assert.equal(await usableTrial(config, avc([0, 1, 1]), 3), false)
    // The configuration comes with the first chunk.
    assert.equal(await usableTrial(config, avc(undefined, {}, 1), 3), false)
    // Durations come from the submitted frames; timestamps must be theirs exactly.
    const timing = (shift: number) =>
        avc().map(({ chunk, metadata }, i) => ({
            chunk: { ...chunk, timestamp: chunk.timestamp + (i ? shift : 0), duration: null },
            metadata,
        }))
    assert.equal(await usableTrial(config, timing(0), 3), true)
    assert.equal(await usableTrial(config, timing(1), 3), false)
    // A missing coded size is read from the SPS; the SPS's size must be the requested one.
    assert.equal(
        await usableTrial(
            config,
            avc(undefined, { codedWidth: undefined, codedHeight: undefined }),
            3,
        ),
        true,
    )
    assert.equal(await usableTrial({ ...config, height: 192 }, avc(), 3), false)
    assert.equal(
        await usableTrial(
            config,
            avc(undefined, { displayAspectWidth: 4, displayAspectHeight: 3 }),
            3,
        ),
        false,
    )
    // A different valid profile is kept; the requested one is not required.
    assert.equal(await usableTrial({ ...config, codec: 'avc1.4d001f' }, avc(), 3), true)
    // Firefox's SPS repeats its NAL header byte, so its profile disagrees with the record's.
    const firefox = new Uint8Array([...avcC.subarray(0, 8), 103, ...avcC.subarray(8)])
    firefox[7] = 24
    assert.equal(await usableTrial(config, avc(undefined, { description: firefox }), 3), false)
    // An SPS slot holding a PPS, a truncated SPS and a PPS slot holding an SPS each fail.
    const sps = [...avcC.subarray(8, 31)]
    const record = (set: number[], pps = [0x68, 0xee, 0x3c, 0x80]) =>
        new Uint8Array([
            1,
            0x64,
            0,
            0x1e,
            0xff,
            0xe1,
            0,
            set.length,
            ...set,
            1,
            0,
            pps.length,
            ...pps,
        ])
    for (const description of [
        record([0x68, ...sps.slice(1)]),
        record(sps.slice(0, 6)),
        record(sps, [0x67, 0xee, 0x3c, 0x80]),
    ])
        assert.equal(await usableTrial(config, avc(undefined, { description }), 3), false)
    // Without a description, the muxer cannot read length-prefixed H.264.
    assert.equal(await usableTrial(config, avc(undefined, { description: undefined }), 3), false)
    // The muxer rejects a first packet that is not a key frame.
    const dependent = avc()
    dependent[0] = { ...dependent[0]!, chunk: { ...dependent[0]!.chunk, type: 'delta' } }
    assert.equal(await usableTrial(config, dependent, 3), false)
})

test('trials run one at a time, only at the selected video settings, and a rejected one is unsupported', async () => {
    const trials: string[] = []
    let running = 0
    let overlapped = false
    const probes = createCodecProbes({
        video: async () => ({ supported: true }),
        audio: async (c) => ({ supported: c.codec === 'opus' }),
        trial: async (c) => {
            overlapped ||= running > 0
            running++
            await new Promise((resolve) => setImmediate(resolve))
            running--
            trials.push(`${c.codec} ${c.height}`)
            return c.codec.startsWith('vp09')
        },
    })
    const availability = createCodecAvailability(probes)
    const silent = { ...settings, bgm: false, sfx: false }
    const state = await availability.update(silent, {
        mp4: { format: 'mp4' },
        webm: { format: 'webm' },
        small: { width: 1280, height: 720 },
    })
    assert.equal(state.current?.supported && state.current.format, 'webm')
    assert.deepEqual(state.choices.mp4, { supported: false, reason: 'videoConfig' })
    assert.equal(state.choices.webm?.supported, true)
    assert.equal(state.choices.small?.supported && state.choices.small.format, 'mp4')
    assert.deepEqual(trials.sort(), [
        'avc1.42002a 1080',
        'avc1.4d002a 1080',
        'avc1.64002a 1080',
        'vp09.00.41.08 1080',
    ])
    assert.equal(overlapped, false)
    // With sound, MP4 needs AAC first, so no H.264 trial runs.
    trials.length = 0
    await probes.resolve({ ...settings, width: 1280, height: 720 })
    assert.deepEqual(trials, ['vp09.00.40.08 720'])
})

test('Export waits only for its own trials, and a trial that no update wants is skipped, not failed', async () => {
    const trials: string[] = []
    let release!: () => void
    const held = new Promise<void>((resolve) => {
        release = resolve
    })
    const probes = createCodecProbes({
        video: async () => ({ supported: true }),
        trial: async (c) => {
            trials.push(`${c.codec.slice(0, 7)} ${c.height}`)
            await held
            return !c.codec.startsWith('avc1.64')
        },
    })
    const availability = createCodecAvailability(probes)
    const silent = { ...settings, bgm: false, sfx: false }
    const first = availability.update(silent, {})
    await new Promise((resolve) => setImmediate(resolve))
    const shown: { codec?: string; webm: boolean }[] = []
    const second = availability.update(
        { ...silent, width: 1280, height: 720 },
        { webm: { format: 'webm' } },
        (state) => {
            const codec = state.current?.supported ? state.current.video.codec : undefined
            shown.push({ codec: codec?.slice(0, 7), webm: 'webm' in state.choices })
        },
    )
    release()
    await Promise.all([first, second])
    // The first update's Main trial was queued behind the second update's and skipped.
    assert.deepEqual(trials, ['avc1.64 1080', 'avc1.64 720', 'avc1.4d 720', 'vp09.00 720'])
    // The selection is published before the WebM choice's trial.
    assert.deepEqual(shown, [
        { codec: 'avc1.4d', webm: false },
        { codec: 'avc1.4d', webm: true },
    ])
    const again = await probes.resolve(silent)
    assert.equal(again.supported && again.video.codec.slice(0, 7), 'avc1.4d')
    assert.equal(trials.at(-1), 'avc1.4d 1080')
    // The whole configuration, bitrate included, is a trial's key.
    await probes.resolve({ ...silent, videoBitrate: 11e6 })
    const retried = trials.length
    assert.ok(retried > 5)
    await probes.resolve({ ...silent, videoBitrate: 11e6 })
    assert.equal(trials.length, retried)
})

test('an AAC delay that cannot be measured makes MP4 with sound unavailable, so Automatic picks WebM', async () => {
    const measured: string[] = []
    const probes = (delay: () => Promise<number>) =>
        createCodecProbes({
            video: async () => ({ supported: true }),
            audio: async () => ({ supported: true }),
            trial: async () => true,
            aacDelay: (config) => {
                measured.push(config.codec)
                return delay()
            },
        })
    const failing = probes(() => Promise.reject(new Error('AAC delay could not be measured')))
    const automatic = await failing.resolve(settings)
    assert.equal(automatic.supported && automatic.format, 'webm')
    assert.equal(automatic.supported && automatic.audio?.codec, 'opus')
    assert.equal(automatic.supported && automatic.aacDelay, undefined)
    assert.deepEqual(await failing.resolve({ ...settings, format: 'mp4' }), {
        supported: false,
        reason: 'audioConfig',
    })
    const working = await probes(() => Promise.resolve(2112)).resolve(settings)
    assert.equal(working.supported && working.format, 'mp4')
    assert.equal(working.supported && working.aacDelay, 2112)
    // Silent exports and WebM measure nothing; choices without trials use the probes alone.
    measured.length = 0
    await failing.resolve({ ...settings, bgm: false, sfx: false })
    await failing.resolve({ ...settings, format: 'webm' })
    const untried = await failing.resolve({ ...settings, format: 'mp4' }, { trial: false })
    assert.equal(untried.supported && untried.format, 'mp4')
    assert.deepEqual(measured, [])
})

test('shared work stops when its last caller leaves, and neither a cancel nor a failure is kept', async () => {
    const shared = createSharedWork<number>()
    let runs = 0
    const stops: AbortSignal[] = []
    const hold = (stop: AbortSignal) => {
        runs++
        stops.push(stop)
        return new Promise<number>((resolve, reject) => {
            stop.addEventListener('abort', () => {
                reject(stop.reason as Error)
            })
            setImmediate(() => {
                if (runs > 1) resolve(7)
            })
        })
    }
    const first = new AbortController()
    const second = new AbortController()
    const a = shared('key', hold, first.signal)
    const b = shared('key', hold, second.signal)
    first.abort()
    await assert.rejects(a, { name: 'AbortError' })
    assert.equal(stops[0]!.aborted, false)
    second.abort()
    await assert.rejects(b, { name: 'AbortError' })
    assert.equal(stops[0]!.aborted, true)
    // The cancelled work is forgotten: the next caller runs it again.
    await assert.rejects(
        shared('key', () => Promise.reject(new Error('failed')), undefined),
        /failed/,
    )
    assert.equal(await shared('key', hold), 7)
    assert.equal(await shared('key', hold), 7)
    assert.equal(runs, 2)
})

test('Cancel leaves trials and AAC measurement: none is kept as unsupported', async () => {
    const calls: string[] = []
    const pending = (name: string) => (signal?: AbortSignal) => {
        calls.push(name)
        return new Promise<never>((_, reject) => {
            signal?.addEventListener('abort', () => {
                reject(signal.reason as Error)
            })
        })
    }
    let held = true
    const probes = createCodecProbes({
        video: async () => ({ supported: true }),
        audio: async () => ({ supported: true }),
        trial: (_, signal) => (held ? pending('trial')(signal) : Promise.resolve(true)),
        aacDelay: (_, signal) => (held ? pending('aac')(signal) : Promise.resolve(2112)),
    })
    for (const s of [settings, { ...settings, bgm: false, sfx: false }]) {
        const controller = new AbortController()
        const resolving = probes.resolve(s, { signal: controller.signal })
        await new Promise((resolve) => setImmediate(resolve))
        controller.abort()
        await assert.rejects(resolving, { name: 'AbortError' })
    }
    assert.deepEqual(calls, ['aac', 'trial'])
    held = false
    const resolved = await probes.resolve(settings)
    assert.equal(resolved.supported && resolved.format, 'mp4')
    assert.equal(resolved.supported && resolved.aacDelay, 2112)
})

test('Cancel closes a trial encoder whose flush never resolves', async () => {
    const globals = globalThis as Record<string, unknown>
    const saved = ['VideoEncoder', 'OffscreenCanvas', 'VideoFrame'].map((name) => globals[name])
    const encoders: { state: string }[] = []
    let flushing!: () => void
    const flushed = new Promise<void>((resolve) => (flushing = resolve))
    globals.VideoEncoder = class {
        state = 'configured'
        constructor() {
            encoders.push(this)
        }
        configure() {}
        encode() {}
        closed?: () => void
        // As in browsers, closing rejects a pending flush.
        flush() {
            flushing()
            return new Promise<void>((_, reject) => {
                this.closed = () => {
                    reject(new DOMException('Closed', 'AbortError'))
                }
            })
        }
        close() {
            this.state = 'closed'
            this.closed?.()
        }
    }
    globals.OffscreenCanvas = class {
        getContext() {
            return { fillRect() {} }
        }
    }
    globals.VideoFrame = class {
        close() {}
    }
    try {
        const trial = browserEncoderProbes().trial!
        const controller = new AbortController()
        const result = trial(
            { codec: 'vp09.00.10.08', width: 16, height: 16, framerate: 30 },
            controller.signal,
        )
        await flushed
        controller.abort()
        await assert.rejects(result, { name: 'AbortError' })
        assert.deepEqual(
            encoders.map((encoder) => encoder.state),
            ['closed'],
        )
    } finally {
        for (const [i, name] of ['VideoEncoder', 'OffscreenCanvas', 'VideoFrame'].entries())
            globals[name] = saved[i]
    }
})
