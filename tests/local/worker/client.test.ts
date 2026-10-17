import assert from 'node:assert/strict'
import test from 'node:test'
import { flushTimeoutMs } from '../../../src/local/flush'
import type { FlushBatch } from '../../../src/local/flushWrite'
import { StorageWorker } from '../../../src/local/worker/client'
import { serve, type Endpoint, type Handlers } from '../../../src/local/worker/rpc'

// The page's watchdog over the storage worker (§1.6.5): an unanswered call pings the worker; one
// that answers with progress is slow, not hung, and is waited for, so a long write is never cut
// off. One that makes no progress, or doesn't answer, is restarted. Real timers, kept short.

type Behaviour = { progress: number; frozen: boolean }

/** A dedicated worker in the same thread: messages cross in later tasks, as postMessage's do. */
class FakeWorker {
    static readonly created: FakeWorker[] = []
    onmessage: ((event: MessageEvent) => void) | null = null
    terminated = false
    readonly state: Behaviour = { progress: 0, frozen: false }
    private readonly inside: Endpoint

    constructor() {
        FakeWorker.created.push(this)
        this.inside = {
            onmessage: null,
            postMessage: (message) => {
                setTimeout(() => {
                    if (!this.terminated) this.onmessage?.({ data: message } as MessageEvent)
                }, 0)
            },
        }
        serve(this.inside, handlers(this.state))
    }

    postMessage(message: unknown) {
        setTimeout(() => {
            // A frozen worker (a long synchronous step) takes no message at all.
            if (!this.terminated && !this.state.frozen)
                this.inside.onmessage?.({ data: message } as MessageEvent)
        }, 0)
    }

    addEventListener() {
        // No uncaught errors here.
    }

    terminate() {
        this.terminated = true
    }
}

const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
        setTimeout(resolve, ms)
    })

const handlers = (state: Behaviour): Handlers => ({
    init: () => ({ mode: 'stored' }),
    ping: () => state.progress,
    /** Long work that keeps moving: a large BGM's write, Try Again's move. */
    slow: async (ms: number) => {
        for (let spent = 0; spent < ms; spent += 10) {
            await sleep(10)
            state.progress++
        }
        return 'done'
    },
    /** Waits for good, answering pings without progress. */
    stuck: () => new Promise(() => undefined),
    /** A synchronous loop: no message is taken any more. */
    freeze: () => {
        state.frozen = true
        return new Promise(() => undefined)
    },
})

const start = async () => {
    FakeWorker.created.length = 0
    ;(globalThis as { Worker?: unknown }).Worker = FakeWorker
    const worker = new StorageWorker(
        { url: 'storage.js', type: 'classic', blobRestart: false },
        { appVersion: '0.6.0', flags: {}, test: true },
        { timeoutMs: 60 },
    )
    await worker.start()
    const call = worker.call.bind(worker) as unknown as (
        method: string,
        arg?: unknown,
    ) => Promise<unknown>
    return { worker, call }
}

test('a call past its timeout that keeps making progress is waited for, never cut off', async () => {
    const { call } = await start()
    assert.equal(await call('slow', 400), 'done')
    assert.equal(FakeWorker.created.length, 1)
    assert.equal(FakeWorker.created[0]?.terminated, false)
})

test('a call that makes no progress restarts the worker', async () => {
    const { call } = await start()
    await assert.rejects(call('stuck'), { name: 'TimeoutError' })
    await sleep(20)
    assert.equal(FakeWorker.created.length, 2)
    assert.equal(FakeWorker.created[0]?.terminated, true)
})

test('a worker that doesn’t answer the ping is restarted', async () => {
    const { call } = await start()
    await assert.rejects(call('freeze'), { name: 'TimeoutError' })
    await sleep(20)
    assert.equal(FakeWorker.created.length, 2)
})

test('a flush’s timeout grows with the bytes it carries', () => {
    const batch = (text: number, media: number[]) =>
        ({
            text: new Uint8Array(text),
            media: media.map((size) => ({ bytes: new ArrayBuffer(size) })),
        }) as unknown as FlushBatch
    assert.equal(flushTimeoutMs(batch(0, [])), 10_000)
    assert.ok(flushTimeoutMs(batch(1000, [20e6])) >= 30_000)
})
