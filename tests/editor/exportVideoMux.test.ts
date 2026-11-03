import { ALL_FORMATS, BufferSource, BufferTarget, EncodedPacketSink, Input } from 'mediabunny'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
    restoreExportError,
    serializeExportError,
    VideoOutputUnavailable,
} from '../../src/exportVideo/error'
import { clipSamples, frameTimestamp } from '../../src/exportVideo/timing'
import {
    aacPacketBound,
    createAudioPacketAdapter,
    createVideoColor,
    createVideoPacketAdapter,
    type MuxInput,
} from '../../src/exportVideo/worker/encode'
import type { WorkerOutput } from '../../src/exportVideo/worker/export.worker'
import { createMuxSink, muxStreamTarget, openMuxOutput } from '../../src/exportVideo/worker/mux'
import type { SinkConfig } from '../../src/exportVideo/worker/sink'
import { readAvcRecord } from '../../src/exportVideo/worker/videoInit'

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
            aacDelay: delay,
        },
        frames: videoFrames,
        frameRate: 30,
        samples,
    }
    const target = new BufferTarget()
    const sink = await createMuxSink(mp4, target)
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
            aacDelay: delay,
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
    const sink = await createMuxSink(mp4, target)
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

// Box layout of a finished MP4, read by size fields rather than by searching the bytes.
type Box = { type: string; end: number; body: number }
const boxesIn = (bytes: Uint8Array, start: number, end: number): Box[] => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const found: Box[] = []
    for (let at = start; at + 8 <= end;) {
        let size = view.getUint32(at)
        let body = at + 8
        if (size === 1) {
            size = Number(view.getBigUint64(at + 8))
            body = at + 16
        } else if (size === 0) size = end - at
        const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8))
        found.push({ type, end: at + size, body })
        at += size
    }
    return found
}
const find = (bytes: Uint8Array, within: Box | undefined, path: string[]): Box | undefined => {
    let box = within
    for (const type of path) {
        if (!box) return undefined
        box = boxesIn(bytes, box.body, box.end).find((b) => b.type === type)
    }
    return box
}
/** The duration field of an mvhd, tkhd or mdhd box, at `at` in version 0 and 8 bytes later in version 1. */
const headerDuration = (bytes: Uint8Array, box: Box, at: number) => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return bytes[box.body]
        ? Number(view.getBigUint64(box.body + at + 8))
        : view.getUint32(box.body + at)
}
const mp4Layout = (bytes: Uint8Array) => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const top = boxesIn(bytes, 0, bytes.length)
    const moov = top.find((b) => b.type === 'moov')!
    const tracks = boxesIn(bytes, moov.body, moov.end)
        .filter((b) => b.type === 'trak')
        .map((trak) => {
            const hdlr = find(bytes, trak, ['mdia', 'hdlr'])!
            const handler = String.fromCharCode(...bytes.subarray(hdlr.body + 8, hdlr.body + 12))
            const stbl = find(bytes, trak, ['mdia', 'minf', 'stbl'])!
            const co64 = find(bytes, stbl, ['co64'])
            const stco = co64 ?? find(bytes, stbl, ['stco'])!
            const count = view.getUint32(stco.body + 4)
            const offsets = Array.from({ length: count }, (_, i) =>
                co64
                    ? Number(view.getBigUint64(stco.body + 8 + 8 * i))
                    : view.getUint32(stco.body + 8 + 4 * i),
            )
            const ctts = find(bytes, stbl, ['ctts'])
            const elst = find(bytes, trak, ['edts', 'elst'])
            const elstVersion = elst ? bytes[elst.body]! : 0
            const mediaTime = elst
                ? elstVersion
                    ? Number(view.getBigInt64(elst.body + 8 + 8))
                    : view.getInt32(elst.body + 8 + 4)
                : undefined
            const segmentDuration = elst
                ? elstVersion
                    ? Number(view.getBigUint64(elst.body + 8))
                    : view.getUint32(elst.body + 8)
                : undefined
            const stts = find(bytes, stbl, ['stts'])!
            const deltas = Array.from({ length: view.getUint32(stts.body + 4) }, (_, i) => [
                view.getUint32(stts.body + 8 + 8 * i),
                view.getUint32(stts.body + 12 + 8 * i),
            ])
            const stsd = find(bytes, stbl, ['stsd'])!
            // The sample entry's fields come before its child boxes: 78 bytes for video.
            const entry = boxesIn(bytes, stsd.body + 8, stsd.end)[0]!
            const children = handler === 'vide' ? boxesIn(bytes, entry.body + 78, entry.end) : []
            const avcC = children.find((b) => b.type === 'avcC')
            return {
                handler,
                offsets,
                ctts: ctts ? view.getUint32(ctts.body + 4) : 0,
                mediaTime,
                segmentDuration,
                duration: headerDuration(bytes, find(bytes, trak, ['tkhd'])!, 20),
                mediaDuration: headerDuration(bytes, find(bytes, trak, ['mdia', 'mdhd'])!, 16),
                deltas,
                colr: children.some((b) => b.type === 'colr'),
                avcC: avcC && bytes.subarray(avcC.body, avcC.end),
            }
        })
    return { top, tracks, duration: headerDuration(bytes, find(bytes, moov, ['mvhd'])!, 16) }
}

const avcRecord = new Uint8Array([
    1, 100, 0, 30, 255, 225, 0, 23, 103, 100, 0, 30, 172, 43, 64, 160, 207, 207, 128, 136, 0, 0, 31,
    64, 0, 7, 83, 0, 120, 225, 53, 1, 0, 4, 104, 238, 60, 176, 253, 248, 248, 0,
])
const fullColor = {
    primaries: 'bt709',
    transfer: 'iec61966-2-1',
    matrix: 'bt709',
    fullRange: true,
} as const

/** One MP4 from the real adapters and muxer: video frames in `order`, audio in `frame`-sample packets. */
const muxMp4 = async (options: {
    order: number[]
    fps?: 30 | 60
    keyEvery?: number
    samples: number
    delay: number
    frame: number
    audioPackets: number
    description?: Uint8Array
    colorSpace?: VideoColorSpaceInit
}) => {
    const fps = options.fps ?? 30
    const frames = options.order.length
    const inputs: MuxInput[] = []
    const video = createVideoPacketAdapter({
        width: 320,
        height: 180,
        frames,
        frameRate: fps,
        color: createVideoColor(),
        emit: (input) => inputs.push(input),
    })
    const audio = createAudioPacketAdapter({
        codec: 'aac',
        samples: options.samples,
        aacDelay: options.delay,
        emit: (input) => inputs.push(input),
    })
    const target = new BufferTarget()
    const sink = await createMuxSink(
        {
            codecs: {
                supported: true,
                format: 'mp4',
                video: { codec: 'avc1.64001e', width: 320, height: 180 },
                audio: { codec: 'mp4a.40.2', numberOfChannels: 2, sampleRate: 48000 },
                aacDelay: options.delay,
            },
            frames,
            frameRate: fps,
            samples: options.samples,
        },
        target,
    )
    const flush = async () => {
        for (const input of inputs.splice(0)) await sink.add(input)
    }
    const keyEvery = options.keyEvery ?? frames
    const audioDuration = (i: number) =>
        Math.round(((i + 1) * options.frame * 1e6) / 48000) -
        Math.round((i * options.frame * 1e6) / 48000)
    let sent = 0
    let submitted = 0
    for (const [i, index] of options.order.entries()) {
        // A frame is submitted before its output, which may come after later frames'.
        for (; submitted <= index; submitted++) video.submit()
        video.output(
            fake(index % keyEvery ? 'delta' : 'key', frameTimestamp(index, fps), [
                0,
                0,
                0,
                2,
                index % keyEvery ? 0x41 : 0x65,
                0x88,
            ]),
            i
                ? undefined
                : {
                      decoderConfig: {
                          codec: 'avc1.64001e',
                          codedWidth: 320,
                          codedHeight: 192,
                          description: options.description ?? avcRecord,
                          colorSpace: options.colorSpace,
                      },
                  },
        )
        // Audio keeps pace with the video, as the frame loop's gates keep it.
        const due = Math.min(
            options.audioPackets,
            Math.ceil(((i + 1) / frames) * options.audioPackets),
        )
        for (; sent < due; sent++)
            audio.output(
                fake('key', 0, [0x21, 0x10, 0x04, 0x60, 0x8c, 0x1c], audioDuration(sent)),
                sent
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
        await flush()
    }
    video.finish()
    audio.finish()
    await flush()
    await sink.finalize()
    return new Uint8Array(target.buffer!)
}

const audioPacketsIn = async (bytes: Uint8Array) => {
    const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(bytes) })
    try {
        const sound = await input.getPrimaryAudioTrack()
        const stamps: number[] = []
        for await (const packet of new EncodedPacketSink(sound!).packets())
            stamps.push(packet.timestamp)
        return stamps
    } finally {
        input.dispose()
    }
}

test('the AAC reservation holds 960- and 1,024-sample packets at both delays around packet boundaries, leaving out trailing packets', async () => {
    const cases: [frame: number, delay: number, samples: number][] = []
    for (const frame of [960, 1024])
        for (const delay of [1024, 2112])
            for (const off of [-1, 0, 1])
                cases.push([frame, delay, 50 * frame + off - 1024 - delay])
    // A minute of 960-sample packets after a 2,112-sample delay.
    cases.push([960, 2112, 60 * 48000])
    for (const [frame, delay, samples] of cases) {
        const needed = Math.ceil((1024 + delay + samples) / frame)
        // Three packets past the clip, as an encoder's flush can add.
        const bytes = await muxMp4({
            order: [0],
            samples,
            delay,
            frame,
            audioPackets: needed + 3,
        })
        const stamps = await audioPacketsIn(bytes)
        assert.equal(stamps.length, needed)
        // The lead-in and the delay come before zero.
        assert.ok(Math.abs(stamps[0]! + (1024 + delay) / 48000) < 1e-6)
        assert.ok(needed <= aacPacketBound(samples, delay))
        // One packet short of the clip is incomplete, unless it ends at most 96 samples short.
        const short = muxMp4({ order: [0], samples, delay, frame, audioPackets: needed - 1 })
        if (1024 + delay + samples - (needed - 1) * frame > 96)
            await assert.rejects(short, /Invalid encoded audio length/)
        else await short
    }
})

for (const fps of [30, 60] as const)
    test(`ten minutes at ${fps} fps with reordered frames fit the reservation, with moov, free and mdat in order and the tracks interleaved`, async () => {
        const frames = 600 * fps
        const gop = 2 * fps
        // Within each two-second group: the key frame, then pairs in swapped order.
        const order: number[] = []
        for (let g = 0; g < frames; g += gop) {
            order.push(g)
            for (let i = g + 1; i < g + gop; i += 2)
                order.push(...(i + 1 < g + gop ? [i + 1, i] : [i]))
        }
        const samples = clipSamples(frames, fps)
        const bytes = await muxMp4({
            order,
            fps,
            keyEvery: gop,
            samples,
            delay: 2112,
            frame: 960,
            audioPackets: Math.ceil((1024 + 2112 + samples) / 960) + 3,
        })
        const { top, tracks } = mp4Layout(bytes)
        const types = top.map((box) => box.type)
        assert.deepEqual(types.slice(0, 4), ['ftyp', 'moov', 'free', 'mdat'])
        const mdat = top[3]!
        const video = tracks.find((track) => track.handler === 'vide')!
        const sound = tracks.find((track) => track.handler === 'soun')!
        // Each swapped pair changes the composition offset, so nearly every frame has its own entry.
        assert.ok(video.ctts > frames * 0.9)
        const chunks = [
            ...video.offsets.map((at) => [at, 0] as const),
            ...sound.offsets.map((at) => [at, 1] as const),
        ].sort((a, b) => a[0] - b[0])
        assert.ok(chunks.every(([at]) => at >= mdat.body && at < mdat.end))
        const switches = chunks.filter(([, track], i) => i && track !== chunks[i - 1]![1]).length
        assert.ok(switches >= 600)
    })

test('the written MP4 keeps several parameter sets after colour patching, colr only with known colour, and the AAC delay in its edit list', async () => {
    const sps = avcRecord.subarray(8, 31)
    const pps = avcRecord.subarray(34, 38)
    const several = new Uint8Array([
        ...avcRecord.subarray(0, 5),
        0xe2,
        0,
        sps.length,
        ...sps,
        0,
        sps.length,
        ...sps,
        2,
        0,
        pps.length,
        ...pps,
        0,
        pps.length,
        ...pps,
        ...avcRecord.subarray(38),
    ])
    const delay = 2112
    for (const colorSpace of [fullColor, undefined]) {
        const bytes = await muxMp4({
            order: [0, 1, 2],
            samples: 4800,
            delay,
            frame: 1024,
            audioPackets: Math.ceil((1024 + delay + 4800) / 1024),
            description: several,
            colorSpace,
        })
        const { tracks } = mp4Layout(bytes)
        const video = tracks.find((track) => track.handler === 'vide')!
        const sound = tracks.find((track) => track.handler === 'soun')!
        assert.equal(video.avcC![5]! & 31, 2)
        assert.equal(readAvcRecord(video.avcC!)?.codec, 'avc1.64001e')
        assert.equal(video.colr, colorSpace !== undefined)
        assert.equal(sound.mediaTime, 1024 + delay)
    }
})

test('the MP4 presents exactly the clip after the lead-in and delay, ending the last AAC packet at the clip end', async () => {
    // Clip ends inside a packet, with no delay and with Chromium's macOS delay, and on a boundary.
    for (const [frames, delay] of [
        [3, 0],
        [3, 2112],
        [2, 896],
    ] as const) {
        const samples = clipSamples(frames, 30)
        const end = 1024 + delay + samples
        const needed = Math.ceil(end / 1024)
        const bytes = await muxMp4({
            order: Array.from({ length: frames }, (_, i) => i),
            samples,
            delay,
            frame: 1024,
            audioPackets: needed + 2,
        })
        const { tracks, duration } = mp4Layout(bytes)
        const video = tracks.find((track) => track.handler === 'vide')!
        const sound = tracks.find((track) => track.handler === 'soun')!
        // Movie timescale 57,600; the audio media timescale is 48,000.
        const clip = (samples * 57600) / 48000
        assert.equal(video.duration, (frames * 57600) / 30)
        assert.equal(duration, video.duration)
        assert.equal(sound.duration, clip)
        assert.equal(sound.segmentDuration, clip)
        assert.equal(sound.mediaTime, 1024 + delay)
        assert.equal(sound.mediaDuration, end)
        const last = end - (needed - 1) * 1024
        assert.deepEqual(
            sound.deltas,
            last === 1024
                ? [[needed, 1024]]
                : [
                      [needed - 1, 1024],
                      [1, last],
                  ],
        )
        const stamps = await audioPacketsIn(bytes)
        assert.equal(stamps.length, needed)
        assert.ok(Math.abs(stamps[0]! + (1024 + delay) / 48000) < 1e-6)
    }
})
