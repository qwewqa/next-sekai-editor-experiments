import assert from 'node:assert/strict'
import test from 'node:test'
import type { MuxInput } from '../../src/exportVideo/worker/encode'
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
        await assert.rejects(async () => {
            output = await openMuxOutput(
                config,
                { kind: 'memory', limit: 1 },
                new AbortController().signal,
            )
            await output.sink.add(packet)
            await output.sink.finalize()
            await output.commit()
        }, /memory limit/)
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
