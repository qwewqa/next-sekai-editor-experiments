import assert from 'node:assert/strict'
import test from 'node:test'
import { flushTimeoutMs } from '../../../src/local/flush'
import type { FlushBatch } from '../../../src/local/flushWrite'
import { StorageWorker } from '../../../src/local/worker/client'
import { serve, type CallScope, type Endpoint, type Handlers } from '../../../src/local/worker/rpc'

// The page's watchdog over the storage worker: an unanswered call pings the worker for
// that call's progress; one that has moved is slow, not hung, and is waited for, so a long write
// is never cut off. One that makes no progress, whatever other calls do, or doesn't answer, is
// restarted. Real timers, kept short.

type Behaviour = { frozen: boolean }

/** A dedicated worker in the same thread: messages cross in later tasks, as postMessage's do. */
class FakeWorker {
    static readonly created: FakeWorker[] = []
    onmessage: ((event: MessageEvent) => void) | null = null
    terminated = false
    readonly state: Behaviour = { frozen: false }
    /** The calls the page sent, pings included. */
    readonly sent: { id: number; method: string; arg: unknown }[] = []
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
        this.sent.push(message as FakeWorker['sent'][number])
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
    /** Long work that keeps moving: a large BGM's write, Try Again's move. */
    slow: async (ms: number, scope: CallScope) => {
        for (let spent = 0; spent < ms; spent += 10) {
            await sleep(10)
            scope.tick()
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
        options?: { timeoutMs?: number },
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

test('a hung call is restarted within about its timeout while another call keeps moving', async () => {
    const { call } = await start()
    const busy = call('slow', 1000).catch((error: unknown) => error)
    await assert.rejects(call('stuck'), { name: 'TimeoutError' })
    // The first ping already finds no progress: the timeout and one ping, not two timeouts.
    // Counted rather than timed, so a loaded machine cannot fail it.
    const sent = FakeWorker.created[0]?.sent ?? []
    const stuck = sent.find((message) => message.method === 'stuck')?.id
    assert.equal(
        sent.filter((message) => message.method === 'ping' && message.arg === stuck).length,
        1,
    )
    // And before the busy call's 1000 ms are through: its progress kept nothing else alive.
    assert.equal(((await busy) as Error).name, 'WorkerRestartedError')
    await sleep(20)
    assert.equal(FakeWorker.created.length, 2)
})

test('the test timeout reaches calls that give their own, as a flush does', async () => {
    const { call } = await start()
    const began = Date.now()
    await assert.rejects(call('stuck', undefined, { timeoutMs: 10_000 }), { name: 'TimeoutError' })
    assert.ok(Date.now() - began < 1000)
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
