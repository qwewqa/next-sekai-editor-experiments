import assert from 'node:assert/strict'
import test from 'node:test'
import {
    createCodecAvailability,
    createCodecProbes,
    h264Level,
    h264Levels,
    outputSize,
    type CodecSettings,
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
