import assert from 'node:assert/strict'
import test from 'node:test'
import { AudioFailure, restoreExportError, serializeExportError } from '../../src/exportVideo/error'
import { clipSamples, frameTimestamp } from '../../src/exportVideo/timing'
import type { ExportStart } from '../../src/exportVideo/types'
import type { MuxInput } from '../../src/exportVideo/worker/encode'
import { createFrameLoop } from '../../src/exportVideo/worker/loop'
import { GraphicsError } from '../../src/exportVideo/worker/renderer'
import { runExport } from '../../src/exportVideo/worker/run'
import { FileError } from '../../src/platform/types'

const deferred = () => {
    let resolve!: () => void
    const promise = new Promise<void>((done) => {
        resolve = done
    })
    return { promise, resolve }
}
const packet = (index: number): MuxInput => ({
    track: 'video',
    packet: {
        timestamp: index * 100000,
        duration: 100000,
        type: 'key',
        data: new Uint8Array([index]),
    },
})

test('a file error retains the code, step and file name across the worker', () => {
    const error = new FileError('conflict', 'Video changed', undefined, 'check', 'clip.webm')
    const restored = restoreExportError(structuredClone(serializeExportError(error)))
    assert.ok(restored instanceof FileError)
    assert.equal(restored.code, 'conflict')
    assert.equal(restored.step, 'check')
    assert.equal(restored.fileName, 'clip.webm')
})

test('an allocation error retains its type across the worker', () => {
    const restored = restoreExportError(
        structuredClone(serializeExportError(new RangeError('Full'))),
    )
    assert.ok(restored instanceof RangeError)
})

test('a slow write gates submissions and the drain includes the pending add', async () => {
    const controller = new AbortController()
    const writes = Array.from({ length: 34 }, deferred)
    let next = 0
    const loop = createFrameLoop({
        signal: controller.signal,
        audio: false,
        queueSize: () => 0,
        write: () => writes[next++]!.promise,
    })
    for (let i = 0; i < 33; i++) {
        await loop.room('video', (i + 1) / 10)
        loop.submitted('video', (i + 1) / 10)
        loop.emit(packet(i))
    }
    assert.equal(loop.stats.queued, 33)
    let ready = false
    const room = loop.room('video', 3.4).then(() => {
        ready = true
    })
    await Promise.resolve()
    assert.equal(ready, false)
    writes[0]!.resolve()
    await room
    loop.emit(packet(33))
    let drained = false
    const drain = loop.drained().then(() => {
        drained = true
    })
    for (const write of writes.slice(1, -1)) write.resolve()
    // The last write must start before it is released.
    while (next < 34) await Promise.resolve()
    assert.equal(drained, false)
    writes[33]!.resolve()
    await drain
    assert.equal(loop.stats.written.video, 34)
    loop.dispose()
})

test('growing encoder lookahead never gates input on output', async () => {
    const controller = new AbortController()
    const loop = createFrameLoop({
        signal: controller.signal,
        audio: false,
        queueSize: () => 0,
        write: () => Promise.resolve(),
    })
    for (let i = 0; i < 80; i++) {
        await loop.room('video', (i + 1) / 30)
        loop.submitted('video', (i + 1) / 30)
        if (i === 0) loop.emit(packet(i))
    }
    assert.equal(loop.stats.submitted.video, 80)
    for (let i = 1; i < 80; i++) loop.emit(packet(i))
    assert.ok(loop.stats.queued > 32)
    await loop.drained()
    assert.equal(loop.stats.written.video, 80)
    loop.dispose()
})

for (const ahead of ['audio', 'video'] as const)
    test(`${ahead} cannot submit more than one second ahead`, async () => {
        const controller = new AbortController()
        const loop = createFrameLoop({
            signal: controller.signal,
            audio: true,
            queueSize: () => 0,
            write: () => Promise.resolve(),
        })
        const behind = ahead === 'audio' ? 'video' : 'audio'
        for (let unit = 1; unit <= 10; unit++) {
            await loop.room(ahead, unit / 10)
            loop.submitted(ahead, unit / 10)
        }
        let ready = false
        const room = loop.room(ahead, 1.1).then(() => {
            ready = true
        })
        await Promise.resolve()
        assert.equal(ready, false)
        await loop.room(behind, 0.1)
        loop.submitted(behind, 0.1)
        await room
        loop.submitted(ahead, 1.1)
        assert.ok(loop.stats.submittedEnd[ahead] - loop.stats.submittedEnd[behind] <= 1)
        loop.complete(behind)
        await loop.room(ahead, 20)
        loop.dispose()
    })

for (const failure of ['cancel', 'encoder', 'write'] as const)
    test(`${failure} settles all gates and a pending block request`, async () => {
        const controller = new AbortController()
        const target = deferred()
        const error = new Error('injected failure')
        const loop = createFrameLoop({
            signal: controller.signal,
            audio: true,
            queueSize: () => 3,
            write: async () => {
                await target.promise
                if (failure === 'write') throw error
            },
        })
        loop.emit(packet(0))
        const waits = [
            loop.room('video', 0.1),
            loop.room('audio', 0.1),
            loop.audioFed(),
            loop.drained(),
            loop.guard(new Promise(() => undefined)),
        ]
        const settled = Promise.all(waits.map((wait) => assert.rejects(wait)))
        if (failure === 'cancel') controller.abort()
        else if (failure === 'encoder') loop.fail(error)
        else target.resolve()
        await settled
        loop.dispose()
    })

test('dequeue and the final audio unit wake their own waits', async () => {
    const controller = new AbortController()
    let queued = 3
    const loop = createFrameLoop({
        signal: controller.signal,
        audio: true,
        queueSize: () => queued,
        write: () => Promise.resolve(),
    })
    const room = loop.room('audio', 0.1)
    let fed = false
    const audioFed = loop.audioFed().then(() => {
        fed = true
    })
    queued = 0
    loop.wake()
    await room
    assert.equal(fed, false)
    loop.submitted('audio', 0.1)
    loop.complete('audio')
    await audioFed
    loop.dispose()
})

test('audio accounting excludes the pad, priming and final padding', async () => {
    const loop = createFrameLoop({
        signal: new AbortController().signal,
        audio: true,
        queueSize: () => 0,
        write: () => Promise.resolve(),
    })
    loop.submitted('audio', 0.1)
    loop.emit({
        track: 'audio',
        packet: {
            type: 'key',
            timestamp: -(1336 * 1e6) / 48000,
            duration: 140000,
            data: new Uint8Array([1]),
        },
        timing: {
            sampleRate: 48000,
            startSamples: 1336,
            playableSamples: 4800,
            endSample: 6136,
        },
    })
    await loop.drained()
    assert.equal(loop.stats.written.audio, 0.1)
    assert.equal(loop.stats.inFlight.audio, 0)
    loop.dispose()
})

/**
 * A VP9 encoder that outputs each frame at once, or with `hold` at its flush as in quality mode,
 * with a flush that resolves or never does. With `failAt`, it fails as that frame is encoded,
 * after its earlier output.
 */
const fakeEncoders = (flush: 'resolves' | 'hangs', failAt?: number, hold = false) => {
    const made: { state: string; flushed: boolean }[] = []
    class FakeVideoEncoder {
        state = 'unconfigured'
        flushed = false
        encodeQueueSize = 0
        constructor(private readonly init: VideoEncoderInit) {
            made.push(this)
        }
        configure() {
            this.state = 'configured'
        }
        addEventListener() {}
        encode(frame: { timestamp: number }) {
            if (this.state === 'closed') throw new DOMException('Closed', 'InvalidStateError')
            if (this.encodeCount === failAt) {
                this.state = 'closed'
                queueMicrotask(() => {
                    this.init.error(new DOMException('Encoding failed', 'EncodingError'))
                })
                return
            }
            const first = this.encodeCount++ === 0
            const output = () =>
                this.init.output(
                    {
                        type: first ? 'key' : 'delta',
                        timestamp: frame.timestamp,
                        duration: null,
                        byteLength: 2,
                        copyTo: (target: Uint8Array) => {
                            new Uint8Array(target.buffer).set([0x82, 0])
                        },
                    } as unknown as EncodedVideoChunk,
                    first
                        ? {
                              decoderConfig: {
                                  codec: 'vp09.00.10.08',
                                  codedWidth: 16,
                                  codedHeight: 16,
                              },
                          }
                        : undefined,
                )
            if (hold) this.held.push(output)
            else output()
        }
        held: (() => void)[] = []
        encodeCount = 0
        flush() {
            for (const output of this.held.splice(0)) output()
            this.flushed = true
            return flush === 'hangs' ? new Promise<void>(() => undefined) : Promise.resolve()
        }
        close() {
            this.state = 'closed'
        }
    }
    return { made, VideoEncoder: FakeVideoEncoder }
}

/** An Opus encoder that outputs 20 ms packets for its input, or fails where `fail` says. */
class FakeAudioEncoder {
    static fail: 'configure' | 'encode' | 'error' | undefined
    state = 'unconfigured'
    encodeQueueSize = 0
    input = 0
    sent = 0
    constructor(private readonly init: AudioEncoderInit) {}
    configure() {
        if (FakeAudioEncoder.fail === 'configure') throw new TypeError('Unsupported audio')
        this.state = 'configured'
    }
    addEventListener() {}
    encode(audio: { numberOfFrames: number }) {
        if (FakeAudioEncoder.fail === 'encode')
            throw new DOMException('Closed', 'InvalidStateError')
        if (FakeAudioEncoder.fail === 'error') {
            this.state = 'closed'
            queueMicrotask(() => {
                this.init.error(new DOMException('Encoding failed', 'EncodingError'))
            })
            return
        }
        this.input += audio.numberOfFrames
        for (; (this.sent + 1) * 960 <= this.input; this.sent++)
            this.init.output(
                {
                    type: 'key',
                    timestamp: 0,
                    duration: 20000,
                    byteLength: 1,
                    copyTo: () => undefined,
                } as unknown as EncodedAudioChunk,
                this.sent
                    ? undefined
                    : {
                          decoderConfig: {
                              codec: 'opus',
                              sampleRate: 48000,
                              numberOfChannels: 2,
                              description: Uint8Array.from(
                                  [...'OpusHead']
                                      .map((c) => c.charCodeAt(0))
                                      .concat([1, 2, 56, 1, 0x80, 0xbb, 0, 0, 0, 0, 0]),
                              ),
                          },
                      },
            )
    }
    flush() {
        const left = this.input - this.sent * 960
        if (left > 0)
            this.init.output({
                type: 'key',
                timestamp: 0,
                duration: 20000,
                byteLength: 1,
                copyTo: () => undefined,
            } as unknown as EncodedAudioChunk)
        return Promise.resolve()
    }
    close() {
        this.state = 'closed'
    }
}

const runFake = async (options: {
    flush?: 'resolves' | 'hangs'
    controller?: AbortController
    whileRunning?: (made: { state: string; flushed: boolean }[]) => Promise<void>
    frames?: number
    /** The capture of this frame finds the graphics context lost. */
    lostAt?: number
    /** The video encoder fails as this frame is encoded. */
    failAt?: number
    /** Frames whose drawing reports a problem. */
    incomplete?: number[]
    audio?: boolean
    /** The page never answers the request for sound. */
    mixHangs?: boolean
    /** The video encoder holds its output until its flush. */
    hold?: boolean
}) => {
    const { made, VideoEncoder } = fakeEncoders(
        options.flush ?? 'resolves',
        options.failAt,
        options.hold,
    )
    const controller = options.controller ?? new AbortController()
    const globals = globalThis as Record<string, unknown>
    const saved = {
        VideoEncoder: globals.VideoEncoder,
        AudioEncoder: globals.AudioEncoder,
        AudioData: globals.AudioData,
        createImageBitmap: globals.createImageBitmap,
    }
    globals.VideoEncoder = VideoEncoder
    globals.AudioEncoder = FakeAudioEncoder
    globals.AudioData = class {
        numberOfFrames: number
        constructor(init: AudioDataInit) {
            this.numberOfFrames = init.numberOfFrames
        }
        close() {}
    }
    globals.createImageBitmap = () =>
        Promise.reject(new DOMException('No bitmap', 'InvalidStateError'))
    const progress: [number, unknown][] = []
    const written: MuxInput[] = []
    try {
        const frames = options.frames ?? 3
        const samples = clipSamples(frames, 30)
        let blocks = options.audio ? 1 : 0
        const start = {
            settings: { frames, frameRate: 30, width: 16, height: 16 },
            codecs: {
                supported: true,
                format: 'webm',
                video: { codec: 'vp09.00.10.08', width: 16, height: 16 },
                ...(options.audio && {
                    audio: { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 },
                }),
            },
            frames,
            frameRate: 30,
            samples,
        } as unknown as ExportStart
        const running = runExport(start, {
            signal: controller.signal,
            renderer: {
                canvas: {},
                capture: (i: number) => {
                    if (i === options.lostAt)
                        throw new GraphicsError('Export graphics context was lost')
                    return {
                        frame: { timestamp: frameTimestamp(i, 30), close() {} },
                        complete: !options.incomplete?.includes(i),
                    }
                },
                captureStripes: () => {
                    throw new Error('No stripes')
                },
            } as unknown as Parameters<typeof runExport>[1]['renderer'],
            sink: {
                add: (input) => {
                    written.push(input)
                    return Promise.resolve()
                },
                finalize: () => Promise.resolve({ frames }),
                abort: () => Promise.resolve(),
            },
            block: () =>
                options.mixHangs
                    ? new Promise<undefined>(() => undefined)
                    : Promise.resolve(
                          blocks-- > 0
                              ? {
                                    startSample: 0,
                                    planes: [
                                        new Float32Array(samples),
                                        new Float32Array(samples),
                                    ] as [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>],
                                }
                              : undefined,
                      ),
            progress: (count, bitmap) => progress.push([count, bitmap]),
            finishing: () => Promise.resolve(),
        })
        await options.whileRunning?.(made)
        return { result: await running, made, progress, written }
    } finally {
        Object.assign(globals, saved)
    }
}

const videoIn = (written: MuxInput[]) => written.filter((input) => input.track === 'video').length

test('an export without its progress image completes with numeric progress', async () => {
    const { result, made, progress, written } = await runFake({})
    assert.deepEqual(result, { result: { frames: 3 }, warnings: [] })
    assert.deepEqual(progress.at(-1), [3, undefined])
    assert.equal(videoIn(written), 3)
    assert.ok(made.every((encoder) => encoder.state === 'closed'))
})

test('Cancel ends an export whose flush never resolves, and closes its encoder', async () => {
    const controller = new AbortController()
    let encoders: { state: string; flushed: boolean }[] = []
    await assert.rejects(
        runFake({
            flush: 'hangs',
            controller,
            whileRunning: async (made) => {
                encoders = made
                // Bounded, so that an export that fails before its flush cannot hold the run open.
                for (let i = 0; i < 10000 && !made.at(-1)?.flushed; i++)
                    await new Promise((resolve) => setImmediate(resolve))
                controller.abort()
            },
        }),
        (error: unknown) => error instanceof Error && error.name === 'AbortError',
    )
    assert.ok(encoders.length > 0 && encoders.every((encoder) => encoder.state === 'closed'))
})

test('a lost context or a failed video encoder ends the picture there, and the sound goes on', async () => {
    for (const end of [{ lostAt: 2 }, { lostAt: 2, hold: true }, { failAt: 2 }]) {
        const { result, written } = await runFake({ frames: 6, audio: true, ...end })
        assert.equal(videoIn(written), 2)
        assert.deepEqual(result.warnings, [
            { code: 'pictureStopped', at: frameTimestamp(2, 30) / 1e6 },
        ])
        assert.ok(written.some((input) => input.track === 'audioEnd'))
    }
    // With no video before it, the cause is the failure.
    await assert.rejects(runFake({ lostAt: 0 }), (error: unknown) => error instanceof GraphicsError)
    await assert.rejects(runFake({ failAt: 0 }), { name: 'EncodingError' })
})

test(
    'a picture that ends before its first frame fails without waiting for the sound',
    { timeout: 120_000 },
    async () => {
        // The sound never comes here: an export that waited for it would never end.
        await assert.rejects(
            runFake({ lostAt: 0, audio: true, mixHangs: true }),
            (error: unknown) => error instanceof GraphicsError,
        )
        await assert.rejects(runFake({ failAt: 0, audio: true, mixHangs: true }), {
            name: 'EncodingError',
        })
    },
)

test('frames whose drawing reports a problem are kept, with a warning', async () => {
    const { result, written } = await runFake({ incomplete: [0, 2] })
    assert.equal(videoIn(written), 3)
    assert.deepEqual(result.warnings, [{ code: 'framesIncomplete', count: 2 }])
})

test('a sound encoder that fails to configure, encode or run fails the export as the sound', async () => {
    try {
        for (const fail of ['configure', 'encode', 'error'] as const) {
            FakeAudioEncoder.fail = fail
            await assert.rejects(
                runFake({ audio: true }),
                (error: unknown) => error instanceof AudioFailure,
            )
        }
    } finally {
        FakeAudioEncoder.fail = undefined
    }
    const { result } = await runFake({ audio: true })
    assert.deepEqual(result.warnings, [])
})
