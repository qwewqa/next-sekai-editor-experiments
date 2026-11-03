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
    AAC_TAIL,
    aacPacketBound,
    audioAccounting,
    createAacCalibration,
    createAudioFeeder,
    createAudioPacketAdapter,
    createVideoColor,
    createVideoPacketAdapter,
    measureAacDelay,
    normalizeAacDescription,
    opusPreSkip,
    type MuxInput,
} from '../../src/exportVideo/worker/encode'
import { createTestSink } from '../../src/exportVideo/worker/testSink'
import { readAvcRecord, vp9FrameSize } from '../../src/exportVideo/worker/videoInit'

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

test('every encoder receives the silent pad with the first samples in one call, then contiguous units with an exact last sample, and AAC a silent tail with the last', () => {
    for (const codec of ['aac', 'opus'] as const) {
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
            codec,
            (init) => {
                inputs.push(init)
                return {
                    close: () => {
                        closed++
                    },
                } as AudioData
            },
        )
        for (const unit of audioUnits({
            startSample: 0,
            planes: [new Float32Array(5600).fill(0.5), new Float32Array(5600).fill(0.25)],
        }))
            feeder.feed(unit)
        feeder.finish()
        const tail = codec === 'aac' ? AAC_TAIL : 0
        assert.deepEqual(
            inputs.map((i) => [i.timestamp, i.numberOfFrames]),
            [
                [-21333, 1024 + 4800],
                [100000, 800 + tail],
            ],
        )
        // Each plane holds the pad, the unit and the tail.
        for (const [input, before, after] of [
            [inputs[0]!, 1024, 0],
            [inputs[1]!, 0, tail],
        ] as const) {
            const data = input.data as Float32Array
            const frames = input.numberOfFrames
            for (const [plane, value] of [0.5, 0.25].entries()) {
                const samples = data.subarray(plane * frames, (plane + 1) * frames)
                assert.ok(samples.subarray(0, before).every((x) => x === 0))
                assert.ok(samples.subarray(before, frames - after).every((x) => x === value))
                assert.ok(samples.subarray(frames - after).every((x) => x === 0))
            }
        }
        assert.equal(encoded, 2)
        assert.equal(closed, 2)
    }
    assert.equal(aacPacketBound(5600, 2112), Math.ceil(8736 / 960))
})

test('AAC packets put the pad and priming before zero and end at the clip end', () => {
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
        emitted.flatMap((x) =>
            x.track === 'audio' ? [[x.packet.timestamp, x.packet.duration]] : [],
        ),
        (
            [
                [0, 1024],
                [1024, 1024],
                [2048, 800],
            ] as const
        ).map(([sample, length]) => [
            ((sample - 2048) * 1e6) / AUDIO_RATE,
            (length * 1e6) / AUDIO_RATE,
        ]),
    )
    assert.equal(trim.startSamples, 2048)
    assert.equal(trim.playableSamples, 800)
    assert.equal(trim.endSample, 2848)
    assert.equal(trim.paddingSamples, 0)
    assert.deepEqual(emitted.at(-1), { track: 'audioEnd', paddingSamples: 0 })
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

const aacConfig = {
    codec: 'mp4a.40.2',
    sampleRate: 48000,
    numberOfChannels: 2,
    description: new Uint8Array([0x11, 0x90]),
}
const opusConfig = { ...aacConfig, codec: 'opus', description: opusHead(312) }
const audioPackets = (emitted: MuxInput[]) =>
    emitted.flatMap((x) => (x.track === 'audio' ? [x.packet] : []))

test('AAC durations rounded either way give whole samples, and packets after the clip are left out', () => {
    for (const delay of [1024, 2112]) {
        const samples = 4800
        const count = Math.ceil((AUDIO_PAD + delay + samples) / 1024)
        const emitted: MuxInput[] = []
        const adapter = createAudioPacketAdapter({
            codec: 'aac',
            samples,
            aacDelay: delay,
            emit: (input) => emitted.push(input),
        })
        // Two packets more than the clip needs, as an encoder's flush can add.
        for (let i = 0; i < count + 2; i++)
            adapter.output(
                chunk(0, i % 2 ? 21334 : 21333),
                i ? undefined : { decoderConfig: aacConfig },
            )
        const trim = adapter.finish()
        const packets = audioPackets(emitted)
        assert.equal(packets.length, count)
        assert.deepEqual(
            packets.map((p) => Math.round(((p.timestamp + p.duration) * AUDIO_RATE) / 1e6)),
            Array.from({ length: count }, (_, i) =>
                Math.min((i + 1) * 1024 - AUDIO_PAD - delay, samples),
            ),
        )
        assert.equal(trim.paddingSamples, 0)
    }
})

test('audio short of the clip, or a packet without a duration, fails', () => {
    const short = createAudioPacketAdapter({
        codec: 'aac',
        samples: 4800,
        aacDelay: 2112,
        emit: () => undefined,
    })
    const count = Math.ceil((AUDIO_PAD + 2112 + 4800) / 1024) - 1
    for (let i = 0; i < count; i++)
        short.output(chunk(0, 21333), i ? undefined : { decoderConfig: aacConfig })
    assert.throws(() => short.finish(), /Invalid encoded audio length/)
    const missing = createAudioPacketAdapter({ codec: 'opus', samples: 800, emit: () => undefined })
    assert.throws(
        () => missing.output({ ...chunk(0, 0), duration: null }, { decoderConfig: opusConfig }),
        /omitted packet duration/,
    )
})

test('audio that ends at most 96 samples short is a delay read late, with no padding; more fails', () => {
    // The fewest whole packets for a clip whose lead-in, delay and length end on a packet
    // boundary, as 1 clip length in 32 does at 60 fps, with the delay measured one sample late.
    const samples = clipSamples(32, 60)
    // The browser tests' sink accepts what the export accepts.
    const sink = createTestSink({
        codecs: {
            supported: true,
            format: 'mp4',
            video: { codec: 'avc1.42001f', width: 320, height: 180 },
            audio: { codec: 'mp4a.40.2', sampleRate: AUDIO_RATE, numberOfChannels: 2 },
            aacDelay: 1025,
        },
        frames: 32,
        frameRate: 60,
        samples,
    })
    const adapter = createAudioPacketAdapter({
        codec: 'aac',
        samples,
        aacDelay: 1025,
        emit: (input) => void sink.add(input),
    })
    for (let i = 0; i < (AUDIO_PAD + 1024 + samples) / 1024; i++)
        adapter.output(
            chunk(0, i % 2 ? 21334 : 21333),
            i ? undefined : { decoderConfig: aacConfig },
        )
    assert.equal(adapter.finish().paddingSamples, 0)
    const end = AUDIO_PAD + 1024 + 4800
    assert.equal(audioAccounting(1024, 4800, end - 96).paddingSamples, 0)
    assert.throws(() => audioAccounting(1024, 4800, end - 97), /Invalid encoded audio length/)
})

/** An AAC encoder with `delay` samples of priming that loses its last packet, as Chromium on Android does. */
const droppingAacEncoder = (
    delay: number,
    output: (chunk: EncodedAudioChunk, metadata?: EncodedAudioChunkMetadata) => void,
) => {
    let input = 0
    return {
        encode: (audio: AudioData) => {
            input += audio.numberOfFrames
        },
        flush: () => {
            const count = Math.ceil((input + delay) / 1024) - 1
            for (let i = 0; i < count; i++)
                output(
                    chunk(0, i % 2 ? 21334 : 21333),
                    i ? undefined : { decoderConfig: aacConfig },
                )
        },
    }
}

test('an AAC encoder that loses its last packet loses only the tail, and the clip is presented whole', () => {
    for (const fps of [30, 60] as const)
        for (let frames = 1; frames <= 6; frames++)
            for (const delay of [0, 1024, 2048, 2112]) {
                const samples = clipSamples(frames, fps)
                const emitted: MuxInput[] = []
                const adapter = createAudioPacketAdapter({
                    codec: 'aac',
                    samples,
                    aacDelay: delay,
                    emit: (input) => emitted.push(input),
                })
                const encoder = droppingAacEncoder(delay, adapter.output)
                const feeder = createAudioFeeder(
                    encoder,
                    samples,
                    'aac',
                    (init) => ({ numberOfFrames: init.numberOfFrames, close() {} }) as AudioData,
                )
                for (const unit of audioUnits({
                    startSample: 0,
                    planes: [new Float32Array(samples), new Float32Array(samples)],
                }))
                    feeder.feed(unit)
                feeder.finish()
                encoder.flush()
                const trim = adapter.finish()
                assert.equal(trim.paddingSamples, 0)
                const packets = audioPackets(emitted)
                const ends = packets.map((p) =>
                    Math.round(((p.timestamp + p.duration) * AUDIO_RATE) / 1e6),
                )
                assert.equal(
                    Math.round((packets[0]!.timestamp * AUDIO_RATE) / 1e6),
                    -AUDIO_PAD - delay,
                )
                assert.equal(ends.at(-1), samples)
                for (const [i, packet] of packets.entries())
                    if (i)
                        assert.equal(Math.round((packet.timestamp * AUDIO_RATE) / 1e6), ends[i - 1])
            }
})

test('AAC delay measurement passes when the encoder loses its last packet, and fails when the encoded audio does not cover its input', async () => {
    const globals = globalThis as Record<string, unknown>
    const names = ['AudioEncoder', 'AudioDecoder', 'AudioData']
    const saved = names.map((name) => globals[name])
    const delay = 1024
    let lost = 0
    type Callbacks = { output(...values: unknown[]): void }
    // Each encoded packet is 1,024 samples, and the last `lost` are dropped. The decoder puts the
    // impulse after the delay.
    globals.AudioEncoder = class {
        state = 'configured'
        input = 0
        constructor(readonly callbacks: Callbacks) {}
        configure() {}
        encode(audio: AudioData) {
            this.input += audio.numberOfFrames
        }
        flush() {
            const packets = Math.ceil((this.input + delay) / 1024) - lost
            for (let i = 0; i < packets; i++)
                this.callbacks.output(
                    chunk(0, i % 2 ? 21334 : 21333),
                    i ? undefined : { decoderConfig: aacConfig },
                )
            return Promise.resolve()
        }
        close() {
            this.state = 'closed'
        }
    }
    globals.AudioDecoder = class {
        state = 'configured'
        decoded = 0
        constructor(readonly callbacks: Callbacks) {}
        configure() {}
        decode() {
            this.decoded++
        }
        flush() {
            const peak = AUDIO_PAD + 2400 + delay
            for (let i = 0; i < this.decoded; i++)
                this.callbacks.output({
                    numberOfFrames: 1024,
                    copyTo: (plane: Float32Array) => {
                        plane.fill(0)
                        if (peak >= i * 1024 && peak < (i + 1) * 1024) plane[peak - i * 1024] = 1
                    },
                    close: () => undefined,
                })
            return Promise.resolve()
        }
        close() {
            this.state = 'closed'
        }
    }
    globals.AudioData = class {
        numberOfFrames: number
        constructor(init: AudioDataInit) {
            this.numberOfFrames = init.numberOfFrames
        }
        close() {}
    }
    try {
        const config = { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 }
        // The lead-in, 4,800 input samples, the tail and the delay take 8 packets. The first 7
        // cover the input.
        for (lost = 0; lost < 2; lost++) assert.equal(await measureAacDelay(config), delay)
        await assert.rejects(measureAacDelay(config), /Invalid encoded audio length/)
    } finally {
        for (const [i, name] of names.entries()) globals[name] = saved[i]
    }
})

test('audio configuration comes with the first packet, may repeat, and fails when it changes', () => {
    const late = createAudioPacketAdapter({
        codec: 'aac',
        samples: 4800,
        aacDelay: 1024,
        emit: () => undefined,
    })
    assert.throws(() => late.output(chunk(0, 21333)), /omitted audio configuration/)
    const emitted: MuxInput[] = []
    const adapter = createAudioPacketAdapter({
        codec: 'aac',
        samples: 4800,
        aacDelay: 1024,
        emit: (input) => emitted.push(input),
    })
    adapter.output(chunk(0, 21333), { decoderConfig: aacConfig })
    // The same AudioSpecificConfig inside an ES descriptor is the same configuration.
    const decoder = [4, 17, ...new Array<number>(13).fill(0), 5, 2, 0x11, 0x90]
    const wrapped = new Uint8Array([3, 3 + decoder.length, 0, 1, 0, ...decoder])
    adapter.output(chunk(0, 21333), { decoderConfig: { ...aacConfig, description: wrapped } })
    const packets = emitted.flatMap((x) => (x.track === 'audio' ? [x] : []))
    assert.equal(packets.length, 2)
    assert.ok(packets[0]!.decoderConfig && packets[0]!.timing)
    assert.ok(!packets[1]!.decoderConfig && !packets[1]!.timing)
    for (const change of [
        { sampleRate: 44100 },
        { numberOfChannels: 1 },
        { description: new Uint8Array([0x12, 0x10]) },
    ])
        assert.throws(
            () => adapter.output(chunk(0, 21333), { decoderConfig: { ...aacConfig, ...change } }),
            /Audio configuration changed/,
        )
    const opus = createAudioPacketAdapter({ codec: 'opus', samples: 4800, emit: () => undefined })
    opus.output(chunk(0, 20000), { decoderConfig: opusConfig })
    opus.output(chunk(0, 20000), { decoderConfig: { ...opusConfig, description: opusHead(312) } })
    assert.throws(
        () =>
            opus.output(chunk(0, 20000), {
                decoderConfig: { ...opusConfig, description: opusHead(320) },
            }),
        /Audio configuration changed/,
    )
})

// Chromium's 320 by 180 H.264 record, coded as 320 by 192 with 12 rows cropped, and the same SPS
// with colour fields added to its VUI.
const avcC = new Uint8Array([
    1, 100, 0, 30, 255, 225, 0, 23, 103, 100, 0, 30, 172, 43, 64, 160, 207, 207, 128, 136, 0, 0, 31,
    64, 0, 7, 83, 0, 120, 225, 53, 1, 0, 4, 104, 238, 60, 176, 253, 248, 248, 0,
])
const avcColor = new Uint8Array([
    1, 100, 0, 30, 255, 225, 0, 27, 103, 100, 0, 30, 172, 43, 64, 160, 207, 207, 128, 183, 1, 13, 1,
    64, 0, 0, 250, 0, 0, 58, 152, 3, 199, 9, 168, 1, 0, 4, 104, 238, 60, 176, 253, 248, 248, 0,
])
const avcConfig: VideoDecoderConfig = {
    codec: 'avc1.4d401e',
    codedWidth: 320,
    codedHeight: 192,
    description: avcC,
}
const frame = (timestamp: number, duration: number | null = 33333) =>
    ({ ...chunk(timestamp, 0), duration }) as unknown as EncodedVideoChunk
const videoAdapter = (
    frames: number,
    submitted = frames,
    emit = (_: MuxInput) => undefined,
    size = { width: 320, height: 180 },
) => {
    const adapter = createVideoPacketAdapter({
        ...size,
        frames,
        frameRate: 30,
        color: createVideoColor(),
        emit,
    })
    for (let i = 0; i < submitted; i++) adapter.submit()
    return adapter
}

test('video packets keep encoded order, take their frame timing and the record codec string', () => {
    const emitted: MuxInput[] = []
    const adapter = videoAdapter(3, 3, (input) => {
        emitted.push(input)
    })
    adapter.output(frame(0), { decoderConfig: avcConfig })
    adapter.output(frame(66667, null))
    // A repeat whose SPS differs only in its colour fields is the same configuration.
    adapter.output(frame(33333, 33334), { decoderConfig: { ...avcConfig, description: avcColor } })
    adapter.finish()
    const packets = emitted.flatMap((x) => (x.track === 'video' ? [x] : []))
    assert.deepEqual(
        packets.map((x) => [x.packet.timestamp, x.packet.duration]),
        [
            [0, 33333],
            [66667, 33333],
            [33333, 33334],
        ],
    )
    const config = packets[0]!.decoderConfig
    assert.equal(config?.codec, 'avc1.64001e')
    // The SPS crops the padded coded height to the requested one.
    assert.equal(config?.codedWidth, 320)
    assert.equal(config?.codedHeight, 180)
    assert.ok(packets.slice(1).every((x) => !x.decoderConfig))
})

test('every video packet passes through its track colour, later key frames without a configuration included', () => {
    // A 16 by 16 VP9 profile 0 key frame with the given color_space and color_range.
    const keyFrame = (space: number, range: 0 | 1) =>
        new Uint8Array([0x82, 0x49, 0x83, 0x42, (space << 5) | (range << 4), 0, 0xf0, 0, 0xf0])
    const packets = (size: { width: number; height: number }, config: VideoDecoderConfig) => {
        const emitted: MuxInput[] = []
        const adapter = createVideoPacketAdapter({
            ...size,
            frames: 2,
            frameRate: 30,
            color: createVideoColor({ matrix: 'smpte170m', fullRange: false }),
            emit: (input) => emitted.push(input),
        })
        const key = (index: number) => {
            const data = keyFrame(2, 1)
            return {
                ...frame(frameTimestamp(index, 30)),
                byteLength: data.length,
                copyTo: (target: Uint8Array) => target.set(data),
            } as unknown as EncodedVideoChunk
        }
        adapter.submit()
        adapter.submit()
        adapter.output(key(0), { decoderConfig: config })
        adapter.output(key(1))
        adapter.finish()
        return emitted.flatMap((x) => (x.track === 'video' ? [x] : []))
    }
    const vp9 = packets(
        { width: 16, height: 16 },
        {
            codec: 'vp09.00.41.08',
            colorSpace: {
                primaries: 'bt709',
                transfer: 'iec61966-2-1',
                matrix: 'bt709',
                fullRange: true,
            },
        },
    )
    assert.deepEqual(
        vp9.map((x) => x.packet.data),
        [keyFrame(3, 0), keyFrame(3, 0)],
    )
    assert.deepEqual(vp9[0]!.decoderConfig?.colorSpace, {
        primaries: 'bt709',
        transfer: 'iec61966-2-1',
        fullRange: false,
    })
    assert.equal(vp9[1]!.decoderConfig, undefined)
    // H.264 packets never go through the VP9 header rewrite.
    const avc = packets({ width: 320, height: 180 }, avcConfig)
    assert.deepEqual(
        avc.map((x) => x.packet.data),
        [keyFrame(2, 1), keyFrame(2, 1)],
    )
})

test('the displayed size comes from the bitstream and must be the requested one', () => {
    // A missing coded size is read from the SPS.
    videoAdapter(1).output(frame(0), {
        decoderConfig: { ...avcConfig, codedWidth: undefined, codedHeight: undefined },
    })
    // A reported size that matches the request does not hide an SPS that crops to less.
    assert.throws(
        () =>
            videoAdapter(1, 1, undefined, { width: 320, height: 192 }).output(frame(0), {
                decoderConfig: avcConfig,
            }),
        /dimensions differ/,
    )
    // VP9's key frame header gives the frame size: 16 by 16 here, whatever is reported.
    const vp9Key = [0x82, 0x49, 0x83, 0x42, 0x00, 0x00, 0xf0, 0x00, 0xf0]
    const vp9 = (size: { width: number; height: number }, coded?: number) =>
        videoAdapter(1, 1, undefined, size).output(
            {
                ...frame(0),
                byteLength: vp9Key.length,
                copyTo: (target: Uint8Array) => target.set(vp9Key),
            } as unknown as EncodedVideoChunk,
            { decoderConfig: { codec: 'vp09.00.10.08', codedWidth: coded, codedHeight: coded } },
        )
    vp9({ width: 16, height: 16 }, 24)
    assert.throws(() => vp9({ width: 24, height: 24 }, 24), /dimensions differ/)
    assert.equal(vp9FrameSize(new Uint8Array(vp9Key))?.width, 16)
    assert.equal(vp9FrameSize(new Uint8Array([0x82, 0])), undefined)
})

test('a missing or late configuration, an essential change, a missing picture or an unmatched timestamp fails', () => {
    const late = videoAdapter(2)
    assert.throws(() => late.output(frame(0)), /omitted its configuration/)
    for (const change of [
        { codedWidth: 640, codedHeight: 360, description: undefined, codec: 'avc1.64001e' },
        { codec: 'avc1.4d001f', description: undefined },
        { description: new Uint8Array([...avcC.subarray(0, -4), 0x68, 0xef, 0x3c, 0x80]) },
    ]) {
        const changed = videoAdapter(2)
        changed.output(frame(0), { decoderConfig: avcConfig })
        assert.throws(
            () => changed.output(frame(33333), { decoderConfig: { ...avcConfig, ...change } }),
            /configuration changed/,
        )
    }
    const missing = videoAdapter(3)
    missing.output(frame(0), { decoderConfig: avcConfig })
    missing.output(frame(66667))
    assert.throws(() => missing.finish(), /incomplete/)
    for (const timestamp of [33334, 33333]) {
        const adapter = videoAdapter(2, timestamp === 33333 ? 1 : 2)
        adapter.output(frame(0), { decoderConfig: avcConfig })
        // One microsecond off, or a frame not yet submitted, matches nothing.
        assert.throws(() => adapter.output(frame(timestamp)), /misplaced/)
    }
    const twice = videoAdapter(2)
    twice.output(frame(0), { decoderConfig: avcConfig })
    assert.throws(() => twice.output(frame(0)), /misplaced/)
})

test('the H.264 record must be readable, with the profile of its SPS, apart from any colour parsing', () => {
    assert.equal(readAvcRecord(avcC)?.codec, 'avc1.64001e')
    const record = (sps: number[], pps = [0x68, 0xee, 0x3c, 0x80]) =>
        new Uint8Array([
            1,
            0x64,
            0,
            0x1e,
            0xff,
            0xe1,
            0,
            sps.length,
            ...sps,
            1,
            0,
            pps.length,
            ...pps,
        ])
    const sps = [...avcC.subarray(8, 31)]
    assert.equal(readAvcRecord(record(sps))?.codec, 'avc1.64001e')
    // Firefox repeats the NAL header byte.
    for (const bad of [
        record([0x67, ...sps]),
        record([0x68, ...sps.slice(1)]),
        record([0x67, 0x4d, ...sps.slice(2)]),
        record(sps.slice(0, 6)),
        record(sps).subarray(0, 20),
        record(sps, [0x67, 0xee, 0x3c, 0x80]),
        new Uint8Array([1, 0x64, 0, 0x1e, 0xff, 0xe0, 0]),
    ])
        assert.equal(readAvcRecord(bad), undefined)
})

test('Cancel closes both AAC calibration codecs while a flush is pending, and the next call measures again', async () => {
    const globals = globalThis as Record<string, unknown>
    const saved = ['AudioEncoder', 'AudioDecoder', 'AudioData'].map((name) => globals[name])
    const made: { state: string }[] = []
    let flushing!: () => void
    const flushed = new Promise<void>((resolve) => (flushing = resolve))
    class Codec {
        state = 'unconfigured'
        closed?: () => void
        constructor() {
            made.push(this)
        }
        configure() {
            this.state = 'configured'
        }
        encode() {}
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
    globals.AudioEncoder = Codec
    globals.AudioDecoder = Codec
    globals.AudioData = class {
        close() {}
    }
    try {
        const calibrate = createAacCalibration()
        const config = { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 }
        const controller = new AbortController()
        const measuring = calibrate(config, controller.signal)
        await flushed
        controller.abort()
        await assert.rejects(measuring, { name: 'AbortError' })
        assert.deepEqual(
            made.map((codec) => codec.state),
            ['closed', 'closed'],
        )
        void calibrate(config, new AbortController().signal).catch(() => undefined)
        assert.equal(made.length, 4)
    } finally {
        for (const [i, name] of ['AudioEncoder', 'AudioDecoder', 'AudioData'].entries())
            globals[name] = saved[i]
    }
})
