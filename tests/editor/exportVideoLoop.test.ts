import assert from 'node:assert/strict'
import test from 'node:test'
import { restoreExportError, serializeExportError } from '../../src/exportVideo/error'
import { clipSamples, frameTimestamp } from '../../src/exportVideo/timing'
import type { ExportStart } from '../../src/exportVideo/types'
import type { MuxInput } from '../../src/exportVideo/worker/encode'
import { createFrameLoop } from '../../src/exportVideo/worker/loop'
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

/** A VP9 encoder that outputs each frame at once, with a flush that resolves or never does. */
const fakeEncoders = (flush: 'resolves' | 'hangs') => {
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
            const first = this.encodeCount++ === 0
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
                    ? { decoderConfig: { codec: 'vp09.00.10.08', codedWidth: 16, codedHeight: 16 } }
                    : undefined,
            )
        }
        encodeCount = 0
        flush() {
            this.flushed = true
            return flush === 'hangs' ? new Promise<void>(() => undefined) : Promise.resolve()
        }
        close() {
            this.state = 'closed'
        }
    }
    return { made, VideoEncoder: FakeVideoEncoder }
}

const runFake = async (
    flush: 'resolves' | 'hangs',
    controller: AbortController,
    whileRunning?: (made: { state: string; flushed: boolean }[]) => Promise<void>,
) => {
    const { made, VideoEncoder } = fakeEncoders(flush)
    const globals = globalThis as Record<string, unknown>
    const saved = {
        VideoEncoder: globals.VideoEncoder,
        createImageBitmap: globals.createImageBitmap,
    }
    globals.VideoEncoder = VideoEncoder
    globals.createImageBitmap = () =>
        Promise.reject(new DOMException('No bitmap', 'InvalidStateError'))
    const progress: [number, unknown][] = []
    const written: MuxInput[] = []
    try {
        const frames = 3
        const start = {
            settings: { frames, frameRate: 30, width: 16, height: 16 },
            codecs: {
                supported: true,
                format: 'webm',
                video: { codec: 'vp09.00.10.08', width: 16, height: 16 },
            },
            frames,
            frameRate: 30,
            samples: clipSamples(frames, 30),
        } as unknown as ExportStart
        const running = runExport(start, {
            signal: controller.signal,
            renderer: {
                canvas: {},
                capture: (i: number) => ({ timestamp: frameTimestamp(i, 30), close() {} }),
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
            block: () => Promise.resolve(undefined),
            progress: (count, bitmap) => progress.push([count, bitmap]),
            finishing: () => Promise.resolve(),
        })
        await whileRunning?.(made)
        return { result: await running, made, progress, written }
    } finally {
        globals.VideoEncoder = saved.VideoEncoder
        globals.createImageBitmap = saved.createImageBitmap
    }
}

test('an export without its progress image completes with numeric progress', async () => {
    const { result, made, progress, written } = await runFake('resolves', new AbortController())
    assert.deepEqual(result, { frames: 3 })
    assert.deepEqual(progress.at(-1), [3, undefined])
    assert.equal(written.filter((input) => input.track === 'video').length, 3)
    assert.ok(made.every((encoder) => encoder.state === 'closed'))
})

test('Cancel ends an export whose flush never resolves, and closes its encoder', async () => {
    const controller = new AbortController()
    let encoders: { state: string; flushed: boolean }[] = []
    await assert.rejects(
        runFake('hangs', controller, async (made) => {
            encoders = made
            while (!made.at(-1)?.flushed) await new Promise((resolve) => setImmediate(resolve))
            controller.abort()
        }),
        (error: unknown) => error instanceof Error && error.name === 'AbortError',
    )
    assert.ok(encoders.length > 0 && encoders.every((encoder) => encoder.state === 'closed'))
})
