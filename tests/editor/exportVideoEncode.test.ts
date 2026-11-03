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
    AAC_DELAY_ESTIMATE,
    AAC_TAIL,
    aacFrameLength,
    aacPacketBound,
    createAacCalibration,
    createAudioFeeder,
    createAudioPacketAdapter,
    createVideoColor,
    createVideoPacketAdapter,
    measureAacDelay,
    normalizeAacDescription,
    opusPacketSamples,
    opusPreSkip,
    videoPacketBound,
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

test('AAC descriptions yield their ASC, and a missing, short, malformed or object type 0 one the requested configuration', () => {
    const asc = new Uint8Array([0x11, 0x90])
    assert.deepEqual(normalizeAacDescription(asc), asc)
    const decoder = [4, 17, ...new Array<number>(13).fill(0), 5, 2, 0x12, 0x10]
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
    // A wrapped 44.1 kHz configuration is kept as it is.
    assert.deepEqual(normalizeAacDescription(descriptor), new Uint8Array([0x12, 0x10]))
    for (const bad of [
        undefined,
        new Uint8Array([0x11]),
        descriptor.subarray(0, descriptor.length - 1),
        new Uint8Array([0x01, 0x90]),
    ])
        assert.deepEqual(normalizeAacDescription(bad), asc)
    assert.equal(aacFrameLength(asc), 1024)
    assert.equal(aacFrameLength(new Uint8Array([0x11, 0x94])), 960)
    // HE-AAC has no GASpecificConfig here, so its frame length is unknown.
    assert.equal(aacFrameLength(new Uint8Array([0x2b, 0x10])), undefined)
})

test('Opus packet samples come from the TOC byte and frame count', () => {
    // CELT 20 ms, one frame; SILK 60 ms, two frames; hybrid 10 ms, code 3 with three frames.
    assert.equal(opusPacketSamples(new Uint8Array([0xf8])), 960)
    assert.equal(opusPacketSamples(new Uint8Array([0x19])), 5760)
    assert.equal(opusPacketSamples(new Uint8Array([0x63, 0x03])), 1440)
    assert.equal(opusPacketSamples(new Uint8Array([0xfb])), undefined)
    assert.equal(opusPacketSamples(new Uint8Array()), undefined)
})

test('every encoder receives the silent pad in the call with the first samples, then contiguous units with an exact last sample, and AAC also receives a silent tail in the last call', () => {
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
        // In each plane, the samples before and after the unit are zero.
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
    assert.equal(aacPacketBound(5600, 2112), Math.ceil(9760 / 512) + 64)
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
    assert.deepEqual(trim.warnings, [])
    assert.throws(() => adapter.finish(), /closed/)
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

test('a missing packet duration is read from the codec, and audio fails when it cannot be', () => {
    const aac = createAudioPacketAdapter({
        codec: 'aac',
        samples: 800,
        aacDelay: 1024,
        emit: () => undefined,
    })
    aac.output({ ...chunk(0, 0), duration: null }, { decoderConfig: aacConfig })
    aac.output({ ...chunk(0, 0), duration: null })
    aac.output({ ...chunk(0, 0), duration: null })
    assert.deepEqual(aac.finish().warnings, [])
    const opus = (data: number[]) => ({
        ...chunk(0, 0),
        duration: null,
        byteLength: data.length,
        copyTo: (target: AllowSharedBufferSource) => {
            ;(target as Uint8Array).set(data)
        },
    })
    const emitted: MuxInput[] = []
    const adapter = createAudioPacketAdapter({
        codec: 'opus',
        samples: 800,
        emit: (input) => emitted.push(input),
    })
    adapter.output(opus([0xf8]), { decoderConfig: opusConfig })
    adapter.output(opus([0xf9]))
    assert.deepEqual(
        audioPackets(emitted).map((p) => Math.round((p.duration * AUDIO_RATE) / 1e6)),
        [960, 1920],
    )
    assert.throws(() => adapter.output(opus([])), /duration is unknown/)
    const silent = createAudioPacketAdapter({ codec: 'opus', samples: 800, emit: () => undefined })
    assert.throws(() => silent.output(chunk(0, 20000)), /omitted audio configuration/)
    assert.throws(() => silent.finish(), /No audio was encoded/)
})

test('audio that ends more than 96 samples short of the clip has a warning; less is a delay read late', () => {
    for (const [lost, warned] of [
        [96, false],
        [97, true],
    ] as const) {
        const samples = 4800
        const emitted: MuxInput[] = []
        const adapter = createAudioPacketAdapter({
            codec: 'opus',
            samples,
            emit: (input) => emitted.push(input),
        })
        const total = AUDIO_PAD + 312 + samples - lost
        adapter.output(chunk(0, ((total - 960) * 1e6) / AUDIO_RATE), {
            decoderConfig: opusConfig,
        })
        adapter.output(chunk(0, 20000))
        const trim = adapter.finish()
        assert.equal(trim.paddingSamples, 0)
        assert.deepEqual(
            trim.warnings,
            warned ? [{ code: 'soundStopped', at: (samples - lost) / AUDIO_RATE }] : [],
        )
        // The browser tests' sink accepts short sound without padding.
        const sink = createTestSink({
            codecs: {
                supported: true,
                format: 'webm',
                video: { codec: 'vp09.00.10.08', width: 320, height: 180 },
                audio: { codec: 'opus', sampleRate: AUDIO_RATE, numberOfChannels: 2 },
            },
            frames: 3,
            frameRate: 30,
            samples,
        })
        for (const input of emitted) void sink.add(input)
    }
})

test('AAC without a measured delay is placed with the estimate and warns', () => {
    const emitted: MuxInput[] = []
    const adapter = createAudioPacketAdapter({
        codec: 'aac',
        samples: 800,
        emit: (input) => emitted.push(input),
    })
    for (let i = 0; i < 3; i++)
        adapter.output(chunk(0, 21333), i ? undefined : { decoderConfig: aacConfig })
    const trim = adapter.finish()
    assert.equal(trim.startSamples, AUDIO_PAD + AAC_DELAY_ESTIMATE)
    assert.deepEqual(trim.warnings, [{ code: 'audioSyncEstimated' }])
    assert.equal(
        audioPackets(emitted)[0]!.timestamp,
        ((-AUDIO_PAD - AAC_DELAY_ESTIMATE) * 1e6) / AUDIO_RATE,
    )
})

/** An AAC encoder with `delay` samples of priming that loses its last packet, as on Android. */
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
                // The clip's audio is whole, so there is no warning.
                assert.deepEqual(trim.warnings, [])
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

test('AAC delay measurement passes whatever the encoder loses or omits, and fails without an impulse', async () => {
    const globals = globalThis as Record<string, unknown>
    const names = ['AudioEncoder', 'AudioDecoder', 'AudioData']
    const saved = names.map((name) => globals[name])
    const delay = 1024
    let lost = 0
    let peaked = true
    let configured = true
    let decoderDescription: AllowSharedBufferSource | undefined
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
                    i || !configured ? undefined : { decoderConfig: aacConfig },
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
        configure(config: AudioDecoderConfig) {
            decoderDescription = config.description
        }
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
                        if (peaked && peak >= i * 1024 && peak < (i + 1) * 1024)
                            plane[peak - i * 1024] = 1
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
        for (lost = 0; lost < 3; lost++) assert.equal(await measureAacDelay(config), delay)
        // Without a reported configuration, the decoder gets the requested one.
        configured = false
        assert.equal(await measureAacDelay(config), delay)
        assert.deepEqual(decoderDescription, new Uint8Array([0x11, 0x90]))
        peaked = false
        await assert.rejects(measureAacDelay(config), /could not be measured/)
    } finally {
        for (const [i, name] of names.entries()) globals[name] = saved[i]
    }
})

test('audio configuration comes with the first packet, may repeat or be left out, and fails when it changes', () => {
    // AAC without any configuration gets the requested one.
    const late: MuxInput[] = []
    const unconfigured = createAudioPacketAdapter({
        codec: 'aac',
        samples: 4800,
        aacDelay: 1024,
        emit: (input) => late.push(input),
    })
    unconfigured.output(chunk(0, 21333))
    const first = late[0]
    assert.deepEqual(
        first?.track === 'audio' && first.decoderConfig?.description,
        new Uint8Array([0x11, 0x90]),
    )
    const emitted: MuxInput[] = []
    const adapter = createAudioPacketAdapter({
        codec: 'aac',
        samples: 4800,
        aacDelay: 1024,
        emit: (input) => emitted.push(input),
    })
    adapter.output(chunk(0, 21333), { decoderConfig: aacConfig })
    // The same AudioSpecificConfig inside an ES descriptor is the same configuration, and so is
    // a repeat without a description.
    const decoder = [4, 17, ...new Array<number>(13).fill(0), 5, 2, 0x11, 0x90]
    const wrapped = new Uint8Array([3, 3 + decoder.length, 0, 1, 0, ...decoder])
    adapter.output(chunk(0, 21333), { decoderConfig: { ...aacConfig, description: wrapped } })
    adapter.output(chunk(0, 21333), { decoderConfig: { ...aacConfig, description: undefined } })
    const packets = emitted.flatMap((x) => (x.track === 'audio' ? [x] : []))
    assert.equal(packets.length, 3)
    assert.ok(packets[0]!.decoderConfig && packets[0]!.timing)
    assert.ok(packets.slice(1).every((x) => !x.decoderConfig && !x.timing))
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
const frame = (
    timestamp: number,
    type: EncodedVideoChunkType = 'delta',
    data: number[] = [timestamp & 255],
) =>
    ({
        timestamp,
        duration: 33333,
        type,
        byteLength: data.length,
        copyTo: (target: AllowSharedBufferSource) => {
            ;(target as Uint8Array).set(data)
        },
    }) as unknown as EncodedVideoChunk
const key = (timestamp: number) => frame(timestamp, 'key')
const videoAdapter = (
    frames: number,
    emit: (input: MuxInput) => void = () => undefined,
    size = { width: 320, height: 180 },
    frameRate: 30 | 60 = 30,
) =>
    createVideoPacketAdapter({
        codec: 'avc1.64001e',
        ...size,
        frames,
        frameRate,
        color: createVideoColor(),
        emit,
    })
/** Each video packet's first byte and the frame it was placed on. */
const placed = (emitted: MuxInput[], frameRate: 30 | 60 = 30) =>
    emitted.flatMap((x) =>
        x.track === 'video'
            ? [[x.packet.data[0], Math.round((x.packet.timestamp * frameRate) / 1e6)]]
            : [],
    )

test('video packets keep encoded order, take their frame timing and the record codec string', () => {
    const emitted: MuxInput[] = []
    const adapter = videoAdapter(3, (input) => {
        emitted.push(input)
    })
    adapter.output(key(0), { decoderConfig: avcConfig })
    adapter.output(frame(66667))
    // A repeat whose SPS differs only in its colour fields is the same configuration.
    adapter.output(frame(33333), { decoderConfig: { ...avcConfig, description: avcColor } })
    assert.deepEqual(adapter.finish(), [])
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

test("WebKit's timestamps 1 µs early from about 4.03 s, and ordinary rounding, land on their frames without a warning", () => {
    for (const frameRate of [30, 60] as const) {
        const frames = 10 * frameRate
        const emitted: MuxInput[] = []
        const adapter = videoAdapter(frames, (input) => emitted.push(input), undefined, frameRate)
        // WebKit's timestamps, as its bug report models them (https://webkit.org/b/321880).
        const stamp = (i: number) =>
            Math.trunc((frameTimestamp(i, frameRate) / 1000 / 1000) * 1000 * 1000)
        const early: number[] = []
        for (let i = 0; i < frames; i++) {
            const at = stamp(i)
            if (at !== frameTimestamp(i, frameRate)) early.push(i)
            adapter.output(
                frame(at, i % frameRate ? 'delta' : 'key', [i & 255]),
                i ? undefined : { decoderConfig: avcConfig },
            )
        }
        assert.equal(early[0], frameRate === 30 ? 121 : 242)
        assert.deepEqual(adapter.finish(), [])
        assert.deepEqual(
            placed(emitted, frameRate).map(([, index]) => index),
            Array.from({ length: frames }, (_, i) => i),
        )
        for (const x of emitted)
            if (x.track === 'video') {
                const index = Math.round((x.packet.timestamp * frameRate) / 1e6)
                assert.equal(x.packet.timestamp, frameTimestamp(index, frameRate))
            }
    }
})

test('reordered output keeps its frames; a taken, early or out-of-range frame moves after the latest one, with a warning', () => {
    const emitted: MuxInput[] = []
    const adapter = videoAdapter(6, (input) => emitted.push(input))
    adapter.output(frame(0, 'key', [10]), { decoderConfig: avcConfig })
    adapter.output(frame(66667, 'delta', [11]))
    adapter.output(frame(33333, 'delta', [12]))
    // The same timestamp with other bytes, then a time before the group and one past the clip.
    adapter.output(frame(33333, 'delta', [13]))
    adapter.output(frame(-33333, 'delta', [14]))
    adapter.output(frame(1e9, 'delta', [15]))
    assert.deepEqual(placed(emitted), [
        [10, 0],
        [11, 2],
        [12, 1],
        [13, 3],
        [14, 4],
        [15, 5],
    ])
    assert.deepEqual(adapter.finish(), [{ code: 'timingReassigned', count: 3 }])
    // A key packet must follow every earlier frame.
    const group: MuxInput[] = []
    const keys = videoAdapter(4, (input) => group.push(input))
    keys.output(frame(0, 'key', [1]), { decoderConfig: avcConfig })
    keys.output(frame(66667, 'delta', [2]))
    keys.output(frame(33333, 'key', [3]))
    keys.output(frame(33333, 'delta', [4]))
    assert.deepEqual(placed(group), [
        [1, 0],
        [2, 2],
        [3, 3],
        [4, 4],
    ])
    assert.deepEqual(keys.finish(), [
        { code: 'framesMissing', count: 1 },
        { code: 'timingReassigned', count: 2 },
    ])
})

test('missing first, middle and last frames keep the rest at their times, with a warning', () => {
    const emitted: MuxInput[] = []
    const adapter = videoAdapter(6, (input) => emitted.push(input))
    // Leading deltas are skipped; the first key packet starts at frame 0.
    adapter.output(frame(0, 'delta', [1]), { decoderConfig: avcConfig })
    adapter.output(frame(33333, 'key', [2]))
    adapter.output(frame(100000, 'delta', [3]))
    adapter.output(frame(133333, 'delta', [4]))
    assert.deepEqual(placed(emitted), [
        [2, 0],
        [3, 3],
        [4, 4],
    ])
    assert.deepEqual(adapter.finish(), [
        { code: 'framesMissing', count: 3 },
        { code: 'timingReassigned', count: 1 },
    ])
    const one = videoAdapter(60)
    one.output(key(0), { decoderConfig: avcConfig })
    assert.deepEqual(one.finish(), [{ code: 'framesMissing', count: 59 }])
    const none = videoAdapter(2)
    none.output(frame(0), { decoderConfig: avcConfig })
    assert.throws(() => none.finish(), /No usable video/)
})

test('extra packets are placed after the clip up to the bound, which ends the picture', () => {
    const frames = 3
    const bound = videoPacketBound(frames)
    assert.equal(bound, 123)
    assert.equal(videoPacketBound(3000), 3300)
    const emitted: MuxInput[] = []
    const adapter = videoAdapter(frames, (input) => emitted.push(input))
    adapter.output(key(0), { decoderConfig: avcConfig })
    for (let i = 1; i < bound + 5; i++) adapter.output(frame(33333))
    const indices = placed(emitted).map(([, index]) => index)
    assert.equal(indices.length, bound)
    assert.deepEqual(indices.slice(0, 3), [0, 1, 2])
    assert.equal(indices.at(-1), bound - 1)
    assert.ok(adapter.ended)
    // Every frame of the clip has a picture, so the picture did not stop early.
    assert.deepEqual(adapter.finish(), [{ code: 'timingReassigned', count: bound - 2 }])
})

test('every video packet passes through its track colour, later key frames without a configuration included', () => {
    // A 16 by 16 VP9 profile 0 key frame with the given color_space and color_range.
    const keyFrame = (space: number, range: 0 | 1) => [
        0x82,
        0x49,
        0x83,
        0x42,
        (space << 5) | (range << 4),
        0,
        0xf0,
        0,
        0xf0,
    ]
    const packets = (size: { width: number; height: number }, config: VideoDecoderConfig) => {
        const emitted: MuxInput[] = []
        const adapter = createVideoPacketAdapter({
            codec: config.codec,
            ...size,
            frames: 2,
            frameRate: 30,
            color: createVideoColor({ matrix: 'smpte170m', fullRange: false }),
            emit: (input) => emitted.push(input),
        })
        adapter.output(frame(0, 'key', keyFrame(2, 1)), { decoderConfig: config })
        adapter.output(frame(frameTimestamp(1, 30), 'key', keyFrame(2, 1)))
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
        vp9.map((x) => [...x.packet.data]),
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
        avc.map((x) => [...x.packet.data]),
        [keyFrame(2, 1), keyFrame(2, 1)],
    )
})

test('the size comes from the bitstream, then the report, then the request, and another size has a warning', () => {
    // A missing coded size is read from the SPS.
    const cropped = videoAdapter(1)
    cropped.output(key(0), {
        decoderConfig: { ...avcConfig, codedWidth: undefined, codedHeight: undefined },
    })
    assert.deepEqual(cropped.finish(), [])
    // A reported size that matches the request does not hide an SPS that crops to less.
    const emitted: MuxInput[] = []
    const larger = videoAdapter(1, (input) => emitted.push(input), { width: 320, height: 192 })
    larger.output(key(0), { decoderConfig: avcConfig })
    assert.deepEqual(larger.finish(), [{ code: 'resolutionDiffers', width: 320, height: 180 }])
    const first = emitted[0]
    assert.equal(first?.track === 'video' && first.decoderConfig?.codedHeight, 180)
    // VP9's key frame header gives the frame size: 16 by 16 here, whatever is reported.
    const vp9Key = [0x82, 0x49, 0x83, 0x42, 0x00, 0x00, 0xf0, 0x00, 0xf0]
    const vp9 = (size: { width: number; height: number }, config?: VideoDecoderConfig) => {
        const out: MuxInput[] = []
        const adapter = createVideoPacketAdapter({
            codec: 'vp09.00.10.08',
            ...size,
            frames: 1,
            frameRate: 30,
            color: createVideoColor(),
            emit: (input) => out.push(input),
        })
        adapter.output(frame(0, 'key', vp9Key), config && { decoderConfig: config })
        const head = out[0]
        return {
            warnings: adapter.finish(),
            config: head?.track === 'video' ? head.decoderConfig : undefined,
        }
    }
    const vp9Config = { codec: 'vp09.00.10.08', codedWidth: 24, codedHeight: 24 }
    assert.deepEqual(vp9({ width: 16, height: 16 }, vp9Config).warnings, [])
    assert.deepEqual(vp9({ width: 24, height: 24 }, vp9Config).warnings, [
        { code: 'resolutionDiffers', width: 16, height: 16 },
    ])
    // Without metadata, VP9 takes the requested codec and the bitstream's size.
    const bare = vp9({ width: 16, height: 16 })
    assert.equal(bare.config?.codec, 'vp09.00.10.08')
    assert.equal(bare.config?.codedWidth, 16)
    assert.deepEqual(bare.warnings, [])
    assert.equal(vp9FrameSize(new Uint8Array(vp9Key))?.width, 16)
    assert.equal(vp9FrameSize(new Uint8Array([0x82, 0])), undefined)
})

test('H.264 waits for a key packet with a usable configuration, and a later essential change ends the picture', () => {
    // A configuration that arrives with a skipped delta packet serves the next key packet.
    const emitted: MuxInput[] = []
    const late = videoAdapter(3, (input) => emitted.push(input))
    late.output(key(0))
    late.output(frame(33333), { decoderConfig: avcConfig })
    late.output(key(66667))
    assert.deepEqual(
        placed(emitted).map(([, index]) => index),
        [0],
    )
    const head = emitted[0]
    assert.equal(head?.track === 'video' && head.decoderConfig?.codec, 'avc1.64001e')
    // Firefox's record, with its NAL header repeated, never starts the video.
    const firefox = videoAdapter(2)
    const bad = new Uint8Array([...avcC.subarray(0, 8), 0x67, ...avcC.subarray(8)])
    bad[7] = 24
    firefox.output(key(0), { decoderConfig: { ...avcConfig, description: bad } })
    firefox.output(key(33333), { decoderConfig: { ...avcConfig, description: bad } })
    assert.throws(() => firefox.finish(), /No usable video/)
    for (const change of [
        { codedWidth: 640, codedHeight: 360, description: undefined, codec: 'avc1.64001e' },
        { codec: 'avc1.4d001f', description: undefined },
        { description: new Uint8Array([...avcC.subarray(0, -4), 0x68, 0xef, 0x3c, 0x80]) },
    ]) {
        const out: MuxInput[] = []
        const changed = videoAdapter(3, (input) => out.push(input))
        changed.output(key(0), { decoderConfig: avcConfig })
        changed.output(frame(33333), { decoderConfig: { ...avcConfig, ...change } })
        changed.output(frame(66667))
        assert.ok(changed.ended)
        assert.equal(placed(out).length, 1)
        assert.deepEqual(changed.finish(), [
            { code: 'pictureStopped', at: frameTimestamp(1, 30) / 1e6 },
        ])
    }
    // An end before any video keeps its cause as the failure.
    const failed = videoAdapter(2)
    failed.end(new Error('Encoder failed'))
    assert.throws(() => failed.finish(), /Encoder failed/)
})

test('the H.264 record must be complete, with the profile of its SPS; size and color parsing are optional', () => {
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
    assert.deepEqual(readAvcRecord(record(sps))?.size, { width: 320, height: 180 })
    // An SPS cut short has no readable size, and the record is still usable.
    const short = readAvcRecord(record(sps.slice(0, 6)))
    assert.equal(short?.codec, 'avc1.64001e')
    assert.equal(short?.size, undefined)
    // Firefox repeats the NAL header byte.
    for (const bad of [
        record([0x67, ...sps]),
        record([0x68, ...sps.slice(1)]),
        record([0x67, 0x4d, ...sps.slice(2)]),
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
