import assert from 'node:assert/strict'
import test, { afterEach, beforeEach, mock } from 'node:test'
import { flushTimeoutMs } from '../../../src/local/flush'
import type { FlushBatch } from '../../../src/local/flushWrite'
import { StorageWorker } from '../../../src/local/worker/client'
import { serve, type CallScope, type Endpoint, type Handlers } from '../../../src/local/worker/rpc'

// The page's watchdog over the storage worker: an unanswered call pings the worker for
// that call's progress; one that has moved is slow, not hung, and is waited for, so a long write
// is never cut off. One that makes no progress, whatever other calls do, or doesn't answer, is
// restarted. The clock is mocked and advances 1 ms at a time. With real timers, a process stalled
// for 60 ms on a loaded machine misses the reply to a ping, and the test fails.

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

beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] })
})

afterEach(() => {
    mock.timers.reset()
})

/** Advances the clock 1 ms at a time until `promise` settles. Callbacks run after each step. */
const settled = async <T>(promise: Promise<T>): Promise<T> => {
    let done = false
    const end = () => {
        done = true
    }
    void promise.then(end, end)
    for (let ms = 0; !done; ms++) {
        assert.ok(ms < 60_000, 'the promise did not settle within 60 s of mocked time')
        mock.timers.tick(1)
        await new Promise((resolve) => setImmediate(resolve))
    }
    return promise
}

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
    await settled(worker.start())
    const call = worker.call.bind(worker) as unknown as (
        method: string,
        arg?: unknown,
        options?: { timeoutMs?: number },
    ) => Promise<unknown>
    return { worker, call }
}

test('a call past its timeout that keeps making progress is waited for, never cut off', async () => {
    const { call } = await start()
    assert.equal(await settled(call('slow', 400)), 'done')
    assert.equal(FakeWorker.created.length, 1)
    assert.equal(FakeWorker.created[0]?.terminated, false)
})

test('a call that makes no progress restarts the worker', async () => {
    const { call } = await start()
    await assert.rejects(settled(call('stuck')), { name: 'TimeoutError' })
    await settled(sleep(20))
    assert.equal(FakeWorker.created.length, 2)
    assert.equal(FakeWorker.created[0]?.terminated, true)
})

test('a hung call is restarted within about its timeout while another call keeps moving', async () => {
    const { call } = await start()
    const busy = call('slow', 1000).catch((error: unknown) => error)
    await assert.rejects(settled(call('stuck')), { name: 'TimeoutError' })
    // The first ping finds no progress, so the restart comes after one timeout and one ping.
    const sent = FakeWorker.created[0]?.sent ?? []
    const stuck = sent.find((message) => message.method === 'stuck')?.id
    assert.equal(
        sent.filter((message) => message.method === 'ping' && message.arg === stuck).length,
        1,
    )
    // The restart also ends the busy call before its 1000 ms, so the busy call's progress does not
    // keep the stuck call waiting.
    assert.equal(((await settled(busy)) as Error).name, 'WorkerRestartedError')
    await settled(sleep(20))
    assert.equal(FakeWorker.created.length, 2)
})

test('the test timeout reaches calls that give their own, as a flush does', async () => {
    const { call } = await start()
    const began = Date.now()
    await assert.rejects(settled(call('stuck', undefined, { timeoutMs: 10_000 })), {
        name: 'TimeoutError',
    })
    assert.ok(Date.now() - began < 1000)
})

test("a worker that doesn't answer the ping is restarted", async () => {
    const { call } = await start()
    await assert.rejects(settled(call('freeze')), { name: 'TimeoutError' })
    await settled(sleep(20))
    assert.equal(FakeWorker.created.length, 2)
})

test("a flush's timeout grows with the bytes it carries", () => {
    const batch = (text: number, media: number[]) =>
        ({
            text: new Uint8Array(text),
            media: media.map((size) => ({ bytes: new ArrayBuffer(size) })),
        }) as unknown as FlushBatch
    assert.equal(flushTimeoutMs(batch(0, [])), 10_000)
    assert.ok(flushTimeoutMs(batch(1000, [20e6])) >= 30_000)
})
