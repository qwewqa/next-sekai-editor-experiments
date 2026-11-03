import { ALL_FORMATS, BufferSource, BufferTarget, EncodedPacketSink, Input } from 'mediabunny'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
    restoreExportError,
    serializeExportError,
    VideoOutputUnavailable,
} from '../../src/exportVideo/error'
import {
    createAudioPacketAdapter,
    createVideoColor,
    createVideoPacketAdapter,
    type MuxInput,
} from '../../src/exportVideo/worker/encode'
import type { WorkerOutput } from '../../src/exportVideo/worker/export.worker'
import { createMuxSink, muxStreamTarget, openMuxOutput } from '../../src/exportVideo/worker/mux'
import type { SinkConfig } from '../../src/exportVideo/worker/sink'

const config: SinkConfig = {
    codecs: {
        supported: true,
        format: 'webm',
        video: { codec: 'vp09.00.10.08', width: 16, height: 16 },
    },
    frames: 1,
    frameRate: 30,
    samples: 1600,
}
const packet: MuxInput = {
    track: 'video',
    packet: { type: 'key', timestamp: 0, duration: 33333, data: new Uint8Array([0x82, 0]) },
    decoderConfig: { codec: 'vp09.00.10.08', codedWidth: 16, codedHeight: 16 },
}

test('a memory export fails when container bytes exceed the limit', async () => {
    let output: WorkerOutput | undefined
    try {
        await assert.rejects(
            async () => {
                output = await openMuxOutput(
                    config,
                    { kind: 'memory', limit: 1 },
                    new AbortController().signal,
                )
                await output.sink.add(packet)
                await output.sink.finalize()
                await output.commit()
            },
            (error: unknown) => {
                const restored = restoreExportError(structuredClone(serializeExportError(error)))
                assert.ok(restored instanceof VideoOutputUnavailable)
                assert.equal(restored.reason, 'memoryLimit')
                return true
            },
        )
    } finally {
        await output?.sink.abort()
        await output?.abort()
    }
})

test('finalising a streamed container waits for writes without committing the target', async () => {
    let release!: () => void
    let writing!: () => void
    const started = new Promise<void>((resolve) => {
        writing = resolve
    })
    const held = new Promise<void>((resolve) => {
        release = resolve
    })
    let closed = false
    let writes = 0
    const sink = await createMuxSink(
        config,
        muxStreamTarget({
            async write() {
                writes++
                writing()
                await held
            },
            close() {
                closed = true
                return Promise.resolve()
            },
            abort() {
                return Promise.resolve()
            },
        }),
    )
    await sink.add(packet)
    let finalized = false
    const pending = sink.finalize().then(() => {
        finalized = true
    })
    await started
    assert.equal(finalized, false)
    assert.equal(closed, false)
    release()
    await pending
    assert.ok(writes > 0)
    assert.equal(closed, false)
})

test('an MP4 with AAC puts moov before mdat and starts the audio at the AAC delay before zero', async () => {
    const avcC = new Uint8Array([
        1, 100, 0, 30, 255, 225, 0, 23, 103, 100, 0, 30, 172, 43, 64, 160, 207, 207, 128, 136, 0, 0,
        31, 64, 0, 7, 83, 0, 120, 225, 53, 1, 0, 4, 104, 238, 60, 176, 253, 248, 248, 0,
    ])
    const delay = 2112
    const videoFrames = 3
    const samples = 4096
    // As many packets as an encoder emits for the 1024-sample pad, the delay and the samples.
    const encoded = 1024 + delay + samples
    const audioPackets = Math.ceil(encoded / 1024)
    const mp4: SinkConfig = {
        codecs: {
            supported: true,
            format: 'mp4',
            video: { codec: 'avc1.64001e', width: 16, height: 16 },
            audio: { codec: 'mp4a.40.2', numberOfChannels: 2, sampleRate: 48000 },
        },
        frames: videoFrames,
        frameRate: 30,
        samples,
    }
    const target = new BufferTarget()
    const sink = await createMuxSink({ ...mp4, aacDelay: delay }, target)
    for (let i = 0; i < videoFrames; i++)
        await sink.add({
            track: 'video',
            packet: {
                type: i === 0 ? 'key' : 'delta',
                timestamp: Math.round((i * 1e6) / 30),
                duration: 33333,
                data: new Uint8Array([0, 0, 0, 2, i === 0 ? 0x65 : 0x41, 0x88]),
            },
            decoderConfig: {
                codec: 'avc1.64001e',
                codedWidth: 16,
                codedHeight: 16,
                description: avcC,
            },
        })
    for (let i = 0; i < audioPackets; i++)
        await sink.add({
            track: 'audio',
            packet: {
                type: 'key',
                timestamp: Math.round(((i * 1024 - delay) * 1e6) / 48000),
                duration: Math.round((1024 * 1e6) / 48000),
                data: new Uint8Array([0x21, 0x10, 0x04, 0x60, 0x8c, 0x1c]),
            },
            decoderConfig: {
                codec: 'mp4a.40.2',
                numberOfChannels: 2,
                sampleRate: 48000,
                description: new Uint8Array([0x11, 0x90]),
            },
        })
    await sink.add({ track: 'audioEnd', paddingSamples: audioPackets * 1024 - encoded })
    await sink.finalize()

    const bytes = new Uint8Array(target.buffer!)
    const at = (name: string) => Buffer.from(bytes).indexOf(name, 0, 'latin1')
    assert.ok(at('moov') > 0 && at('mdat') > 0)
    assert.ok(at('moov') < at('mdat'))

    const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(bytes) })
    try {
        const video = await input.getPrimaryVideoTrack()
        const audio = await input.getPrimaryAudioTrack()
        assert.ok(video && audio)
        const videoStamps: number[] = []
        for await (const packet of new EncodedPacketSink(video).packets())
            videoStamps.push(packet.timestamp)
        const audioStamps: number[] = []
        for await (const packet of new EncodedPacketSink(audio).packets())
            audioStamps.push(packet.timestamp)
        assert.equal(videoStamps.length, videoFrames)
        assert.equal(audioStamps.length, audioPackets)
        assert.ok(Math.abs(audioStamps[0]! + delay / 48000) < 1e-6)
    } finally {
        input.dispose()
    }
})

const fake = (
    type: EncodedVideoChunkType,
    timestamp: number,
    data: number[],
    duration: number | null = null,
) =>
    ({
        type,
        timestamp,
        duration,
        byteLength: data.length,
        copyTo: (target: Uint8Array) => {
            new Uint8Array(target.buffer).set(data)
        },
    }) as unknown as EncodedVideoChunk & EncodedAudioChunk

test('adapter output muxes into an MP4 with moov first, encoded order and the cropped size', async () => {
    const avcC = new Uint8Array([
        1, 100, 0, 30, 255, 225, 0, 23, 103, 100, 0, 30, 172, 43, 64, 160, 207, 207, 128, 136, 0, 0,
        31, 64, 0, 7, 83, 0, 120, 225, 53, 1, 0, 4, 104, 238, 60, 176, 253, 248, 248, 0,
    ])
    const delay = 2112
    const frames = 3
    const samples = 4800
    const mp4: SinkConfig = {
        codecs: {
            supported: true,
            format: 'mp4',
            video: { codec: 'avc1.4d401e', width: 320, height: 180 },
            audio: { codec: 'mp4a.40.2', numberOfChannels: 2, sampleRate: 48000 },
        },
        frames,
        frameRate: 30,
        samples,
    }
    const inputs: MuxInput[] = []
    const video = createVideoPacketAdapter({
        width: 320,
        height: 180,
        frames,
        frameRate: 30,
        color: createVideoColor(),
        emit: (input) => inputs.push(input),
    })
    for (let i = 0; i < frames; i++) video.submit()
    // Decode order 0, 2, 1, without durations.
    video.output(fake('key', 0, [0, 0, 0, 2, 0x65, 0x88]), {
        decoderConfig: {
            codec: 'avc1.4d401e',
            codedWidth: 320,
            codedHeight: 192,
            description: avcC,
            colorSpace: {
                primaries: 'bt709',
                transfer: 'iec61966-2-1',
                matrix: 'bt709',
                fullRange: true,
            },
        },
    })
    video.output(fake('delta', 66667, [0, 0, 0, 2, 0x41, 0x88]))
    video.output(fake('delta', 33333, [0, 0, 0, 2, 0x01, 0x88]))
    video.finish()
    const audio = createAudioPacketAdapter({
        codec: 'aac',
        samples,
        aacDelay: delay,
        emit: (input) => inputs.push(input),
    })
    const count = Math.ceil((1024 + delay + samples) / 1024)
    for (let i = 0; i < count; i++)
        audio.output(
            fake('key', 0, [0x21, 0x10, 0x04, 0x60, 0x8c, 0x1c], 21333),
            i
                ? undefined
                : {
                      decoderConfig: {
                          codec: 'mp4a.40.2',
                          numberOfChannels: 2,
                          sampleRate: 48000,
                          description: new Uint8Array([0x11, 0x90]),
                      },
                  },
        )
    audio.finish()
    const target = new BufferTarget()
    const sink = await createMuxSink({ ...mp4, aacDelay: delay }, target)
    for (const input of inputs) await sink.add(input)
    await sink.finalize()

    const bytes = new Uint8Array(target.buffer!)
    const at = (name: string) => Buffer.from(bytes).indexOf(name, 0, 'latin1')
    assert.ok(at('moov') > 0 && at('moov') < at('mdat'))
    const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(bytes) })
    try {
        const track = await input.getPrimaryVideoTrack()
        const sound = await input.getPrimaryAudioTrack()
        assert.ok(track && sound)
        assert.equal(await track.getCodecParameterString(), 'avc1.64001e')
        const config = await track.getDecoderConfig()
        assert.deepEqual(
            new Uint8Array(config!.description as ArrayBuffer).subarray(0, 4),
            avcC.subarray(0, 4),
        )
        assert.equal(track.displayWidth, 320)
        assert.equal(track.displayHeight, 180)
        const stamps: number[] = []
        for await (const packet of new EncodedPacketSink(track).packets())
            stamps.push(Math.round(packet.timestamp * 30))
        assert.deepEqual(stamps, [0, 2, 1])
        let packets = 0
        for await (const packet of new EncodedPacketSink(sound).packets()) {
            void packet
            packets++
        }
        assert.equal(packets, count)
    } finally {
        input.dispose()
    }
})
