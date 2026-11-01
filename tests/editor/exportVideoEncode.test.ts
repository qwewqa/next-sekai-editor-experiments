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
    audioTrim,
    createAacCalibration,
    createAudioFeeder,
    createAudioPacketAdapter,
    normalizeAacDescription,
    opusPreSkip,
    videoPacket,
    type MuxInput,
} from '../../src/exportVideo/worker/encode'

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

test('AAC packets start at zero and carry the pad and delay only in the trim', () => {
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
        [0, 21333, 42667],
    )
    assert.equal(trim.startSamples, 2048)
    assert.equal(trim.playableSamples, 800)
    assert.equal(trim.endSample, 2848)
    assert.equal(trim.discardPaddingSamples, 224)
    assert.deepEqual(emitted.at(-1), { track: 'audioEnd', discardPaddingSamples: 224 })
    assert.throws(() => adapter.finish(), /incomplete/)
})

test('Opus pre-skip includes the pad while seek pre-roll stays 80 ms', () => {
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
    assert.equal(trim.codecDelayNanoseconds, 27833333)
    assert.equal(trim.seekPreRollNanoseconds, 80000000)
    assert.equal(trim.discardPaddingSamples, 744)
    assert.throws(() => audioTrim(312, 800, 1000, true), /Invalid/)
})

test('video packets retain the encoder color metadata without a replacement tag', () => {
    const colorSpace = {
        primaries: 'bt709',
        transfer: 'iec61966-2-1',
        matrix: 'bt709',
        fullRange: true,
    } as const
    const config = { codec: 'vp09.00.41.08', codedWidth: 1920, codedHeight: 1080, colorSpace }
    const result = videoPacket(chunk(0, 16667), { decoderConfig: config })
    assert.ok(result.track === 'video')
    assert.equal(result.decoderConfig?.colorSpace, colorSpace)
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
