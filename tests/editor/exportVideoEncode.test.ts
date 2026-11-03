import assert from 'node:assert/strict'
import test from 'node:test'
import {
    AUDIO_PAD,
    AUDIO_RATE,
    audioUnits,
    clipSamples,
    frameTimestamp,
    sampleTimestamp,
} from '../../src/exportVideo/timing'
import {
    aacPacketBound,
    audioAccounting,
    createAacCalibration,
    createAudioFeeder,
    createAudioPacketAdapter,
    createVideoColor,
    normalizeAacDescription,
    opusPreSkip,
    videoPacket,
    type MuxInput,
} from '../../src/exportVideo/worker/encode'
import { vp9KeyFrame } from './videoColorFixtures'

const chunk = (timestamp: number, duration: number): EncodedAudioChunk => ({
    timestamp,
    duration,
    type: 'key',
    byteLength: 1,
    copyTo: (target) => {
        new Uint8Array((target as Uint8Array).buffer)[0] = 7
    },
})
const opusHead = (skip: number) => {
    const head = new Uint8Array(19)
    head.set(new TextEncoder().encode('OpusHead'))
    head[8] = 1
    head[9] = 2
    head[10] = skip & 255
    head[11] = skip >> 8
    return head
}

test('integer audio and frame timestamps stay aligned over a long clip at both frame rates', () => {
    for (const fps of [30, 60] as const) {
        const frames = fps * 90 * 60 + 1
        assert.equal(sampleTimestamp(clipSamples(frames, fps)), frameTimestamp(frames, fps))
        assert.equal(clipSamples(1, fps), fps === 30 ? 1600 : 800)
    }
    assert.equal(sampleTimestamp(-AUDIO_PAD), -21333)
})

test('AAC ES descriptors yield ASC, including variable lengths and optional ES fields', () => {
    const asc = new Uint8Array([0x11, 0x90])
    assert.deepEqual(normalizeAacDescription(asc), asc)
    const decoder = [4, 17, ...new Array<number>(13).fill(0), 5, 2, ...asc]
    const header = [0, 1, 0xe0, 0, 2, 3, 65, 66, 67, 0, 3]
    const descriptor = new Uint8Array([
        3,
        0x80,
        0x80,
        0x80,
        header.length + decoder.length,
        ...header,
        ...decoder,
    ])
    assert.deepEqual(normalizeAacDescription(descriptor), asc)
    assert.throws(
        () => normalizeAacDescription(descriptor.subarray(0, descriptor.length - 1)),
        /Invalid/,
    )
})

test('every encoder receives the silent pad and contiguous units with an exact last sample', () => {
    const inputs: AudioDataInit[] = []
    let closed = 0
    let encoded = 0
    const feeder = createAudioFeeder(
        {
            encode: () => {
                encoded++
            },
        },
        5600,
        (init) => {
            inputs.push(init)
            return {
                close: () => {
                    closed++
                },
            } as AudioData
        },
    )
    feeder.pad()
    for (const unit of audioUnits({
        startSample: 0,
        planes: [new Float32Array(5600).fill(0.5), new Float32Array(5600).fill(0.25)],
    }))
        feeder.feed(unit)
    feeder.finish()
    assert.deepEqual(
        inputs.map((i) => [i.timestamp, i.numberOfFrames]),
        [
            [-21333, 1024],
            [0, 4800],
            [100000, 800],
        ],
    )
    assert.ok((inputs[0]!.data as Float32Array).every((x) => x === 0))
    assert.equal(encoded, 3)
    assert.equal(closed, 3)
    assert.equal(feeder.submittedEnd, 5600 / AUDIO_RATE)
    assert.throws(() => feeder.pad(), /already/)
    assert.equal(aacPacketBound(5600, 2), 9)
})

test('AAC packets put the pad and priming before zero and retain final padding', () => {
    const emitted: MuxInput[] = []
    const adapter = createAudioPacketAdapter({
        codec: 'aac',
        samples: 800,
        aacDelay: 1024,
        emit: (input) => emitted.push(input),
    })
    adapter.output(chunk(-42667, 21333), {
        decoderConfig: {
            codec: 'mp4a.40.2',
            sampleRate: 48000,
            numberOfChannels: 2,
            description: new Uint8Array([0x11, 0x90]),
        },
    })
    adapter.output(chunk(-21334, 21334))
    adapter.output(chunk(0, 21333))
    const first = emitted[0]!
    assert.equal(first.track === 'audio' && first.timing?.startSamples, 2048)
    assert.equal(first.track === 'audio' && first.timing?.playableSamples, 800)
    assert.equal(emitted.filter((input) => input.track === 'audio' && input.timing).length, 1)
    const trim = adapter.finish()
    assert.deepEqual(
        emitted.filter((x) => x.track === 'audio').map((x) => x.packet.timestamp),
        [0, 1024, 2048].map((sample) => ((sample - 2048) * 1e6) / AUDIO_RATE),
    )
    assert.equal(trim.startSamples, 2048)
    assert.equal(trim.playableSamples, 800)
    assert.equal(trim.endSample, 2848)
    assert.equal(trim.paddingSamples, 224)
    assert.deepEqual(emitted.at(-1), { track: 'audioEnd', paddingSamples: 224 })
    assert.throws(() => adapter.finish(), /incomplete/)
})

test('Opus pre-skip and negative timestamps include the pad', () => {
    const emitted: MuxInput[] = []
    const original = opusHead(312)
    const adapter = createAudioPacketAdapter({
        codec: 'opus',
        samples: 800,
        emit: (input) => emitted.push(input),
    })
    adapter.output(chunk(-27833, 20000), {
        decoderConfig: {
            codec: 'opus',
            sampleRate: 48000,
            numberOfChannels: 2,
            description: original,
        },
    })
    adapter.output(chunk(-7833, 20000))
    adapter.output(chunk(12167, 20000))
    const trim = adapter.finish()
    const first = emitted[0]!
    assert.equal(first.track === 'audio' && opusPreSkip(first.decoderConfig!.description!), 1336)
    assert.equal(opusPreSkip(original), 312)
    assert.equal(trim.paddingSamples, 744)
    assert.throws(() => audioAccounting(312, 800, 1000), /Invalid/)
})

test('Opus packets are placed end to end at every clip length, also when stamped early by the pre-skip after the first, as Firefox does', () => {
    const config = {
        codec: 'opus',
        sampleRate: 48000,
        numberOfChannels: 2,
        description: opusHead(312),
    }
    // At both rates, 1 to 6 frames cover every remainder after whole 960-sample packets.
    for (const fps of [30, 60] as const)
        for (let frames = 1; frames <= 6; frames++)
            for (const early of [0, 312]) {
                const samples = clipSamples(frames, fps)
                const count = Math.ceil((AUDIO_PAD + 312 + samples) / 960)
                const emitted: MuxInput[] = []
                const adapter = createAudioPacketAdapter({
                    codec: 'opus',
                    samples,
                    emit: (input) => emitted.push(input),
                })
                for (let i = 0; i < count; i++)
                    adapter.output(
                        chunk(sampleTimestamp(i * 960 - AUDIO_PAD - (i ? early : 0)), 20000),
                        i ? undefined : { decoderConfig: config },
                    )
                const trim = adapter.finish()
                const packets = emitted.flatMap((x) => (x.track === 'audio' ? [x.packet] : []))
                assert.deepEqual(
                    packets.map((packet) => [packet.timestamp, packet.duration]),
                    Array.from({ length: count }, (_, i) => [
                        ((i * 960 - AUDIO_PAD - 312) * 1e6) / AUDIO_RATE,
                        20000,
                    ]),
                )
                assert.equal(trim.endSample, AUDIO_PAD + 312 + samples)
                assert.ok(trim.paddingSamples >= 0 && trim.paddingSamples < 960)
            }
})

test('every video packet passes through its track colour', () => {
    const videoChunk = (data: Uint8Array): EncodedVideoChunk =>
        ({
            timestamp: 0,
            duration: 16667,
            type: 'key',
            byteLength: data.length,
            copyTo: (target: Uint8Array) => target.set(data),
        }) as unknown as EncodedVideoChunk
    const colorSpace = {
        primaries: 'bt709',
        transfer: 'iec61966-2-1',
        matrix: 'bt709',
        fullRange: true,
    } as const
    const config = { codec: 'vp09.00.41.08', codedWidth: 1920, codedHeight: 1080, colorSpace }
    const measured = { matrix: 'smpte170m', fullRange: false } as const
    const vp9 = createVideoColor(measured)
    const first = videoPacket(videoChunk(vp9KeyFrame(2, 1)), { decoderConfig: config }, vp9)
    const later = videoPacket(videoChunk(vp9KeyFrame(2, 1)), undefined, vp9)
    assert.ok(first.track === 'video' && later.track === 'video')
    assert.deepEqual(first.packet.data, vp9KeyFrame(3, 0))
    assert.deepEqual(later.packet.data, vp9KeyFrame(3, 0))
    assert.deepEqual(first.decoderConfig?.colorSpace, {
        primaries: 'bt709',
        transfer: 'iec61966-2-1',
        fullRange: false,
    })
    assert.equal(later.decoderConfig, undefined)
    // H.264 packets never go through the VP9 header rewrite.
    const avc = createVideoColor(measured)
    const description = new Uint8Array([1])
    const avcFirst = videoPacket(
        videoChunk(vp9KeyFrame(2, 1)),
        { decoderConfig: { ...config, codec: 'avc1.64001e', description } },
        avc,
    )
    const avcLater = videoPacket(videoChunk(vp9KeyFrame(2, 1)), undefined, avc)
    assert.ok(avcFirst.track === 'video' && avcLater.track === 'video')
    assert.equal(avcFirst.decoderConfig?.description, description)
    assert.equal(avcFirst.decoderConfig.colorSpace, undefined)
    assert.deepEqual(avcFirst.packet.data, vp9KeyFrame(2, 1))
    assert.deepEqual(avcLater.packet.data, vp9KeyFrame(2, 1))
})

test('AAC delay calibration caches the whole configuration and retries failed measurements', async () => {
    let calls = 0
    const measure = createAacCalibration(async () => {
        calls++
        if (calls === 1) throw new Error('encode failed')
        return 2112
    })
    const config = { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 192000 }
    await assert.rejects(measure(config), /encode failed/)
    assert.equal(await measure(config), 2112)
    assert.equal(await measure({ ...config }), 2112)
    await measure({ ...config, bitrate: 256000 })
    assert.equal(calls, 3)
})
