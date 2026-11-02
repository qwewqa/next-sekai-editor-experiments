import assert from 'node:assert/strict'
import test from 'node:test'
import {
    createCodecAvailability,
    createCodecProbes,
    h264Level,
    h264Levels,
    outputSize,
    usableTrial,
    type CodecSettings,
    type TrialChunk,
} from '../../src/exportVideo/codecs'

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

test('a trial encode accepts only output the frame loop can use', () => {
    const config = { codec: 'avc1.64001f', width: 1280, height: 720, framerate: 30 as const }
    const at = (i: number) => Math.round((i * 1e6) / 30)
    const record = (sps: number[]) =>
        new Uint8Array([
            1,
            0x64,
            0,
            0x1f,
            0xff,
            0xe1,
            0,
            sps.length,
            ...sps,
            1,
            0,
            4,
            0x68,
            0xee,
            0x3c,
            0x80,
        ])
    const output = (description?: Uint8Array): TrialChunk[] =>
        [0, 1, 2].map((i) => ({
            type: i ? 'delta' : 'key',
            timestamp: at(i),
            duration: at(i + 1) - at(i),
            decoderConfig: i
                ? undefined
                : { codec: config.codec, codedWidth: 1280, codedHeight: 720, description },
        }))
    const good = output(record([0x67, 0x64, 0, 0x1f, 0xac, 0xd9]))
    assert.equal(usableTrial(config, good, 3), true)
    const vp9 = { ...config, codec: 'vp09.00.31.08' }
    assert.equal(usableTrial(vp9, output(), 3), true)
    // Firefox's High and Main output is one frame late and in decode order. Each fault fails alone.
    const shifted = good.map((chunk, i) => ({ ...chunk, timestamp: at(i + 1) }))
    assert.equal(usableTrial(config, shifted, 3), false)
    const [first, second, third] = good
    const reordered = [first!, { ...third!, duration: second!.duration }, second!]
    assert.equal(usableTrial(config, reordered, 3), false)
    assert.equal(usableTrial(config, good.slice(0, 2), 3), false)
    assert.equal(usableTrial(config, [{ ...first!, type: 'delta' }, second!, third!], 3), false)
    assert.equal(
        usableTrial(vp9, [{ ...first!, decoderConfig: undefined }, second!, third!], 3),
        false,
    )
    assert.equal(usableTrial(config, output(), 3), false)
    // Firefox's SPS repeats its NAL header byte in every profile.
    assert.equal(usableTrial(config, output(record([0x67, 0x67, 0x64, 0, 0x1f, 0xac])), 3), false)
    assert.equal(usableTrial({ ...config, codec: 'avc1.4d001f' }, good, 3), false)
    assert.equal(usableTrial(config, output(record([0x68, 0x64, 0, 0x1f, 0xac, 0xd9])), 3), false)
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
    // Bitrate is not part of a trial's key.
    await probes.resolve({ ...silent, videoBitrate: 11e6 })
    assert.equal(trials.length, 5)
})
