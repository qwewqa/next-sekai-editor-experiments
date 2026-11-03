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
import { AUDIO_BITRATES, RESOLUTIONS } from '../../src/exportVideo/estimate'
import { createAacCalibration } from '../../src/exportVideo/worker/encode'
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

test('a trial accepts output the export can mux or repair, and refuses output it cannot use', async () => {
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
    // VP9 without metadata takes the requested codec and size.
    assert.equal(await usableTrial(vp9, webm(false), 3), true)
    // Presentation order differs from encoded order with B-frames.
    assert.equal(await usableTrial(config, avc([0, 2, 1]), 3), true)
    // Output a frame late, a missing frame and a repeated time are placed on whole frames.
    assert.equal(await usableTrial(config, avc([1, 2, 3]), 3), true)
    assert.equal(await usableTrial(config, avc([0, 1]), 3), true)
    assert.equal(await usableTrial(config, avc([0, 1, 1]), 3), true)
    // A configuration that comes after the key frame leaves no usable video.
    assert.equal(await usableTrial(config, avc(undefined, {}, 1), 3), false)
    // Durations come from the frames; timestamps round to the nearest frame.
    const timing = (shift: number) =>
        avc().map(({ chunk, metadata }, i) => ({
            chunk: { ...chunk, timestamp: chunk.timestamp + (i ? shift : 0), duration: null },
            metadata,
        }))
    assert.equal(await usableTrial(config, timing(0), 3), true)
    assert.equal(await usableTrial(config, timing(-1), 3), true)
    // A missing coded size is read from the SPS; another size or aspect is muxed as it is.
    assert.equal(
        await usableTrial(
            config,
            avc(undefined, { codedWidth: undefined, codedHeight: undefined }),
            3,
        ),
        true,
    )
    assert.equal(await usableTrial({ ...config, height: 192 }, avc(), 3), true)
    assert.equal(
        await usableTrial(
            config,
            avc(undefined, { displayAspectWidth: 4, displayAspectHeight: 3 }),
            3,
        ),
        true,
    )
    // A different valid profile is kept; the requested one is not required.
    assert.equal(await usableTrial({ ...config, codec: 'avc1.4d001f' }, avc(), 3), true)
    // Firefox's SPS repeats its NAL header byte, so its profile disagrees with the record's.
    const firefox = new Uint8Array([...avcC.subarray(0, 8), 103, ...avcC.subarray(8)])
    firefox[7] = 24
    assert.equal(await usableTrial(config, avc(undefined, { description: firefox }), 3), false)
    // An SPS slot holding a PPS and a PPS slot holding an SPS each fail. An SPS whose size
    // cannot be read is still usable.
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
        record(sps, [0x67, 0xee, 0x3c, 0x80]),
    ])
        assert.equal(await usableTrial(config, avc(undefined, { description }), 3), false)
    assert.equal(
        await usableTrial(config, avc(undefined, { description: record(sps.slice(0, 6)) }), 3),
        true,
    )
    // Without a description, the muxer cannot read length-prefixed H.264.
    assert.equal(await usableTrial(config, avc(undefined, { description: undefined }), 3), false)
    // Video starts at a key frame, so output without one is unusable.
    const dependent = avc().map((output) => ({
        ...output,
        chunk: { ...output.chunk, type: 'delta' as const },
    }))
    assert.equal(await usableTrial(config, dependent, 3), false)
})

test('trials run one at a time and only for the selection, and choices use queries and kept results', async () => {
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
    // The MP4 choice reuses the H.264 trials that failed in Automatic's search.
    assert.deepEqual(state.choices.mp4, { supported: false, reason: 'videoTrial' })
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
    // An explicit WebM runs no H.264 trial. With no kept result, the query decides the MP4 choice.
    trials.length = 0
    const webm = await availability.update(
        { ...silent, ...outputSize(1440, 16 / 9), format: 'webm' },
        { mp4: { format: 'mp4' } },
    )
    assert.deepEqual(trials, ['vp09.00.50.08 1440'])
    assert.equal(webm.choices.mp4?.supported, true)
})

test("no choice runs a trial or an AAC measurement, and a choice equal to the selection gets the selection's result", async () => {
    const trials: string[] = []
    const measured: number[] = []
    const probes = createCodecProbes({
        video: async () => ({ supported: true }),
        audio: async () => ({ supported: true }),
        trial: async (c) => {
            trials.push(`${c.codec.slice(0, 7)} ${c.height}`)
            return c.codec.startsWith('vp09')
        },
        aacDelay: async (c) => {
            measured.push(c.bitrate ?? 0)
            return 2112
        },
    })
    // The choices the dialog offers. Format, Audio Bitrate and sound off keep the selected size.
    const choices: Record<string, Partial<CodecSettings>> = {
        ...Object.fromEntries(
            RESOLUTIONS.map((height) => [`resolution:${height}`, outputSize(height, 16 / 9)]),
        ),
        'frameRate:30': { frameRate: 30 },
        'frameRate:60': { frameRate: 60 },
        'format:automatic': { format: 'automatic' },
        'format:mp4': { format: 'mp4' },
        'format:webm': { format: 'webm' },
        ...Object.fromEntries(
            AUDIO_BITRATES.map((audioBitrate) => [
                `audioBitrate:${audioBitrate}`,
                { audioBitrate },
            ]),
        ),
        'sound:off': { bgm: false, sfx: false },
    }
    const availability = createCodecAvailability(probes)
    let published: { current?: object; choices: Record<string, object> }[] = []
    const update = (s: CodecSettings) => {
        published = []
        return availability.update(s, choices, (next) => {
            published.push(next)
        })
    }
    // In both publishes, the choices equal to the selection have the selection's result.
    const equalChoices = (s: CodecSettings) => {
        assert.equal(published.length, 2)
        for (const shown of published)
            for (const key of [
                `format:${s.format}`,
                `audioBitrate:${s.audioBitrate}`,
                'frameRate:60',
                'resolution:1080',
            ])
                assert.equal(shown.choices[key], shown.current)
    }
    const webm = await update({ ...settings, format: 'webm' })
    assert.equal(webm.current?.supported && webm.current.format, 'webm')
    assert.deepEqual(trials, ['vp09.00 1080'])
    assert.deepEqual(measured, [])
    equalChoices({ ...settings, format: 'webm' })
    assert.equal(webm.choices['format:mp4']?.supported, true)
    // MP4 runs its H.264 trials once it is selected. They fail, so no AAC measurement runs.
    const mp4 = await update({ ...settings, format: 'mp4' })
    assert.deepEqual(mp4.current, { supported: false, reason: 'videoTrial' })
    assert.deepEqual(trials, ['vp09.00 1080', 'avc1.64 1080', 'avc1.4d 1080', 'avc1.42 1080'])
    assert.deepEqual(measured, [])
    equalChoices({ ...settings, format: 'mp4' })
    // The kept failures and the kept VP9 pass decide the choices at the same size.
    assert.deepEqual(mp4.choices['audioBitrate:128000'], { supported: false, reason: 'videoTrial' })
    assert.deepEqual(mp4.choices['sound:off'], { supported: false, reason: 'videoTrial' })
    assert.equal(mp4.choices['format:webm']?.supported, true)
    const automatic = mp4.choices['format:automatic']
    assert.equal(automatic?.supported && automatic.format, 'webm')
    // Another frame rate has no kept result, so its query decides.
    assert.equal(mp4.choices['frameRate:30']?.supported, true)
})

test('a superseded update leaves its trials at once, and a trial already started finishes and is kept', async () => {
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
    assert.deepEqual(trials, ['avc1.64 1080', 'avc1.64 720', 'avc1.4d 720'])
    // The selection is published before the WebM choice.
    assert.deepEqual(shown, [
        { codec: 'avc1.4d', webm: false },
        { codec: 'avc1.4d', webm: true },
    ])
    const again = await probes.resolve(silent)
    assert.equal(again.supported && again.video.codec.slice(0, 7), 'avc1.4d')
    assert.deepEqual(trials.slice(3), ['avc1.4d 1080'])
    // The whole configuration, bitrate included, is a trial's key.
    await probes.resolve({ ...silent, videoBitrate: 11e6 })
    const retried = trials.length
    assert.ok(retried > 5)
    await probes.resolve({ ...silent, videoBitrate: 11e6 })
    assert.equal(trials.length, retried)
})

test('quick resolution changes run only the trial already started and the last one', async () => {
    const started: number[] = []
    let release!: () => void
    const held = new Promise<void>((resolve) => {
        release = resolve
    })
    const probes = createCodecProbes({
        video: async () => ({ supported: true }),
        trial: async (c) => {
            started.push(c.height)
            await held
            return true
        },
    })
    const availability = createCodecAvailability(probes)
    const silent = { ...settings, format: 'webm', bgm: false, sfx: false } as const
    const updates: ReturnType<typeof availability.update>[] = []
    for (const height of [540, 720, 1080, 1440]) {
        updates.push(availability.update({ ...silent, ...outputSize(height, 16 / 9) }, {}))
        await new Promise((resolve) => setImmediate(resolve))
    }
    release()
    const states = await Promise.all(updates)
    assert.deepEqual(started, [540, 1440])
    assert.equal(states.at(-1)?.current?.supported, true)
    // The 540 trial ran to its end and is kept.
    await probes.resolve({ ...silent, ...outputSize(540, 16 / 9) })
    assert.deepEqual(started, [540, 1440])
})

test('updates that differ only in audio share one trial, and closing stops every trial at once', async () => {
    const started: string[] = []
    const stops: AbortSignal[] = []
    let release = () => undefined as void
    let held = Promise.resolve()
    const hold = () => {
        held = new Promise<void>((resolve) => {
            release = resolve
        })
    }
    const probes = createCodecProbes({
        video: async () => ({ supported: true }),
        audio: async () => ({ supported: true }),
        trial: async (c, signal) => {
            started.push(`${c.height} ${c.bitrate}`)
            stops.push(signal)
            await held
            return true
        },
    })
    const tick = () => new Promise((resolve) => setImmediate(resolve))
    const webm = { ...settings, format: 'webm' } as const
    hold()
    const availability = createCodecAvailability(probes)
    const first = availability.update(webm, {})
    await tick()
    // Only the audio changes, so the second update probes it before it joins the same trial.
    const second = availability.update({ ...webm, audioBitrate: 128000 }, {})
    await tick()
    release()
    const [, state] = await Promise.all([first, second])
    assert.deepEqual(started, ['1080 12000000'])
    assert.equal(stops[0]!.aborted, false)
    assert.equal(state.current?.supported && state.current.audio?.bitrate, 128000)
    await probes.resolve(webm)
    assert.equal(started.length, 1)
    // Closing stops the running trial of a superseded update and skips the one queued behind it.
    hold()
    void availability.update({ ...webm, height: 720 }, {})
    await tick()
    void availability.update({ ...webm, height: 720, videoBitrate: 11e6 }, {})
    await tick()
    availability.stop()
    assert.equal(stops[1]!.aborted, true)
    release()
    await tick()
    assert.deepEqual(started.slice(1), ['720 12000000'])
    const reopened = createCodecAvailability(probes)
    const update = reopened.update({ ...webm, height: 720, videoBitrate: 11e6 }, {})
    assert.equal((await update).current?.supported, true)
    assert.deepEqual(started.slice(1), ['720 12000000', '720 11000000'])
})

test('an AAC delay that cannot be measured leaves MP4 with sound available, without a measurement', async () => {
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
    let failures = 0
    const failing = probes(() => {
        failures++
        return Promise.reject(new Error('AAC delay could not be measured'))
    })
    const automatic = await failing.resolve(settings)
    assert.equal(automatic.supported && automatic.format, 'mp4')
    assert.equal(automatic.supported && automatic.audio?.codec, 'mp4a.40.2')
    assert.equal(automatic.supported && automatic.aacDelay, undefined)
    const working = await probes(() => Promise.resolve(2112)).resolve(settings)
    assert.equal(working.supported && working.format, 'mp4')
    assert.equal(working.supported && working.aacDelay, 2112)
    // Silent exports, WebM and choices without trials measure nothing.
    measured.length = 0
    await failing.resolve({ ...settings, bgm: false, sfx: false })
    await failing.resolve({ ...settings, format: 'webm' })
    const untried = await failing.resolve({ ...settings, format: 'mp4' }, { trial: false })
    assert.equal(untried.supported && untried.format, 'mp4')
    assert.deepEqual(measured, [])
    // A failed measurement is not kept: the next export measures again.
    await failing.resolve(settings)
    assert.equal(failures, 2)
    // AAC is measured once an H.264 trial passes, and not at all when every one fails.
    const order: string[] = []
    const trying = (passes: boolean) =>
        createCodecProbes({
            video: async () => ({ supported: true }),
            audio: async () => ({ supported: true }),
            trial: async (c) => {
                order.push(c.codec.slice(0, 4))
                return passes || c.codec.startsWith('vp09')
            },
            aacDelay: async () => {
                order.push('aac')
                return 2112
            },
        })
    const webm = await trying(false).resolve(settings)
    assert.equal(webm.supported && webm.format, 'webm')
    assert.deepEqual(order, ['avc1', 'avc1', 'avc1', 'vp09'])
    order.length = 0
    const mp4 = await trying(true).resolve(settings)
    assert.equal(mp4.supported && mp4.aacDelay, 2112)
    assert.deepEqual(order, ['avc1', 'aac'])
})

test('a support query that throws counts as unsupported, the next candidate is tried, and the query is asked again later', async () => {
    let throwing = true
    const asked: string[] = []
    const probes = createCodecProbes({
        video: (config) => {
            asked.push(config.codec)
            if (config.codec.startsWith('avc1.6400')) {
                if (throwing) throw new Error('Query failed')
                return Promise.reject(new DOMException('Query failed', 'OperationError'))
            }
            return Promise.resolve({ supported: true })
        },
        audio: async () => ({ supported: true }),
    })
    const silent = { ...settings, bgm: false, sfx: false, format: 'mp4' as const }
    const first = await probes.resolve(silent, { trial: false })
    assert.equal(first.supported && first.video.codec.slice(0, 9), 'avc1.4d00')
    throwing = false
    await probes.resolve(silent, { trial: false })
    // High was asked both times; Main's answer was kept.
    assert.deepEqual(
        asked.map((codec) => codec.slice(0, 9)),
        ['avc1.6400', 'avc1.4d00', 'avc1.6400'],
    )
    // A refused configuration is kept.
    let refused = 0
    const refusing = createCodecProbes({
        video: () => {
            refused++
            return Promise.reject(new TypeError('Invalid configuration'))
        },
    })
    assert.deepEqual(await refusing.resolve(silent, { trial: false }), {
        supported: false,
        reason: 'videoConfig',
    })
    const before = refused
    await refusing.resolve(silent, { trial: false })
    assert.equal(refused, before)
})

test('a Windows AAC encoder refuses 256 kbps, and the choices show 192 kbps and silent video pass', async () => {
    // Chromium on Windows: AAC up to 192 kbps.
    const probes = createCodecProbes({
        video: async () => ({ supported: true }),
        audio: async (config) => ({
            supported: config.codec !== 'mp4a.40.2' || (config.bitrate ?? 0) <= 192000,
        }),
        trial: async () => true,
    })
    const availability = createCodecAvailability(probes)
    const mp4 = { ...settings, format: 'mp4' as const, audioBitrate: 256000 }
    const state = await availability.update(mp4, {
        'audioBitrate:192000': { audioBitrate: 192000 },
        'format:webm': { format: 'webm' },
        'sound:off': { bgm: false, sfx: false },
    })
    assert.deepEqual(state.current, { supported: false, reason: 'audioConfig' })
    assert.ok(Object.values(state.choices).every((choice) => choice.supported))
    // Automatic still exports, with WebM.
    const automatic = await availability.update({ ...mp4, format: 'automatic' }, {})
    assert.equal(automatic.current?.supported && automatic.current.format, 'webm')
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
    assert.equal(shared.kept('key'), undefined)
    first.abort()
    await assert.rejects(a, { name: 'AbortError' })
    assert.equal(stops[0]!.aborted, false)
    second.abort()
    await assert.rejects(b, { name: 'AbortError' })
    assert.equal(stops[0]!.aborted, true)
    assert.equal(shared.kept('key'), undefined)
    // The next caller runs the canceled work again.
    await assert.rejects(
        shared('key', () => Promise.reject(new Error('failed')), undefined),
        /failed/,
    )
    assert.equal(shared.kept('key'), undefined)
    assert.equal(await shared('key', hold), 7)
    assert.equal(shared.kept('key'), 7)
    assert.equal(await shared('key', hold), 7)
    assert.equal(runs, 2)
})

test('Cancel leaves trials and AAC measurement, and neither is kept as unsupported', async () => {
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
    // The trial is held only in the silent pass. That pass has its own size, so it does not
    // reuse the trial kept from the pass with sound.
    const silent = { ...settings, ...outputSize(720, 16 / 9), bgm: false, sfx: false }
    const probes = createCodecProbes({
        video: async () => ({ supported: true }),
        audio: async () => ({ supported: true }),
        trial: (c, signal) =>
            held && c.height === silent.height ? pending('trial')(signal) : Promise.resolve(true),
        aacDelay: (_, signal) => (held ? pending('aac')(signal) : Promise.resolve(2112)),
    })
    for (const s of [settings, silent]) {
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
    const video = await probes.resolve(silent)
    assert.equal(video.supported && video.format, 'mp4')
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

test(
    'closing the dialog stops its pending trial and AAC measurement, and a reopened one starts afresh',
    { timeout: 10000 },
    async () => {
        const globals = globalThis as Record<string, unknown>
        const names = [
            'VideoEncoder',
            'AudioEncoder',
            'AudioDecoder',
            'OffscreenCanvas',
            'VideoFrame',
            'AudioData',
        ]
        const saved = names.map((name) => globals[name])
        const codecs: { kind: string; state: string }[] = []
        // Codecs whose kind starts with this hold their flushes.
        let hold: string | undefined
        let flushed = () => undefined as void
        const flushing = () =>
            new Promise<void>((resolve) => {
                flushed = resolve
            })
        // As in browsers, closing rejects a pending flush.
        const codec = (name: string) =>
            class {
                kind = name
                state = 'configured'
                closed?: () => void
                constructor() {
                    codecs.push(this)
                }
                configure() {}
                encode() {}
                decode() {}
                flush() {
                    if (!hold || !this.kind.startsWith(hold)) return Promise.resolve()
                    flushed()
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
        Object.assign(globals, {
            VideoEncoder: codec('video'),
            AudioEncoder: codec('audioEncoder'),
            AudioDecoder: codec('audioDecoder'),
            OffscreenCanvas: class {
                getContext() {
                    return { fillRect() {} }
                }
            },
            VideoFrame: class {
                close() {}
            },
            AudioData: class {
                close() {}
            },
        })
        try {
            const trial = browserEncoderProbes().trial!
            // The fake encoder's output never passes a trial. The trial still builds its encoder
            // but passes, so that the AAC measurement runs.
            const probes = createCodecProbes({
                video: async () => ({ supported: true }),
                audio: async () => ({ supported: true }),
                trial: async (c, signal) => {
                    await trial(c, signal)
                    return true
                },
                aacDelay: createAacCalibration(),
            })
            const kinds = () => codecs.map((c) => `${c.kind} ${c.state}`)
            // A dialog with sound closes during its AAC measurement, another without during its
            // trial. The dialog with sound has its own size, so its kept trial is not reused.
            for (const [s, held] of [
                [{ ...settings, ...outputSize(720, 16 / 9) }, 'audio'],
                [{ ...settings, bgm: false, sfx: false }, 'video'],
            ] as const) {
                hold = held
                const dialog = createCodecAvailability(probes)
                const started = flushing()
                const update = dialog.update(s, {})
                await started
                dialog.stop()
                await update
                assert.ok(codecs.every((c) => c.state === 'closed'))
            }
            assert.deepEqual(kinds(), [
                'video closed',
                'audioDecoder closed',
                'audioEncoder closed',
                'video closed',
            ])
            hold = undefined
            const reopened = createCodecAvailability(probes)
            const state = await reopened.update(settings, {})
            assert.equal(state.pending, false)
            // The trial and the measurement ran again with new codecs. The measurement's key has
            // no video size, so the one stopped at 720p was not kept.
            assert.deepEqual(kinds().slice(4), [
                'video closed',
                'audioDecoder closed',
                'audioEncoder closed',
            ])
        } finally {
            for (const [i, name] of names.entries()) globals[name] = saved[i]
        }
    },
)
