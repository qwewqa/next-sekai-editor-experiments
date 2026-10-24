import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { resetRingForTests, ringEntries } from '../../src/diagnostics'
import { mapRead, readValue, storedRead, type StoredRead } from '../../src/local/storedRead'
import { StorageWorker } from '../../src/local/worker/client'
import { connect, serve, type Endpoint, type Handlers } from '../../src/local/worker/rpc'

// The `storedRead` gate: a covered read resolves as its value or as `failed`, and
// never rejects. It runs here over a real `StorageWorker` client (the client's `call` needs its
// `this`, which a detached call loses: the round-2 High bug) and over `connect`'s client.

/** A dedicated worker in the same thread: messages cross in later tasks, as postMessage's do. */
class FakeWorker {
    onmessage: ((event: MessageEvent) => void) | null = null
    private readonly inside: Endpoint

    constructor() {
        this.inside = {
            onmessage: null,
            postMessage: (message) => {
                setTimeout(() => this.onmessage?.({ data: message } as MessageEvent), 0)
            },
        }
        serve(this.inside, handlers)
    }

    postMessage(message: unknown) {
        setTimeout(() => this.inside.onmessage?.({ data: message } as MessageEvent), 0)
    }

    addEventListener() {
        // No uncaught errors here.
    }

    terminate() {
        // Nothing to stop.
    }
}

const failure = () => {
    const error = new Error('The storage worker stopped answering (gate test)')
    error.name = 'TimeoutError'
    return error
}

const handlers: Handlers = {
    init: () => ({ mode: 'stored' }),
    // Covered reads: an answer, an empty answer, a falsy answer and a failure.
    readHandle: (arg: { role: string }) => {
        if (arg.role === 'exportTarget') throw failure()
        return arg.role === 'file' ? { testHandle: 'coconut.nxsp' } : undefined
    },
    listHandleOwners: () => [],
    readChainRecord: (chainId: string) => (chainId === 'none' ? undefined : { chainId }),
    openPendingImports: () => {
        throw failure()
    },
}

const start = async () => {
    ;(globalThis as { Worker?: unknown }).Worker = FakeWorker
    const worker = new StorageWorker(
        { url: 'storage.js', type: 'classic', blobRestart: false },
        { appVersion: '0.6.0', flags: {}, test: true },
        { timeoutMs: 200 },
    )
    await worker.start()
    return worker
}

afterEach(() => {
    resetRingForTests()
})

test('over a real StorageWorker, a read is answered, and `call` keeps its `this`', async () => {
    const worker = await start()
    // A detached `call` throws on `this.ready`, which the gate would report as `failed`.
    const read = await storedRead(worker, 'readHandle', { chainId: 'c', role: 'file' })
    assert.deepEqual(read, { storedRead: 'value', storedValue: { testHandle: 'coconut.nxsp' } })
    assert.equal(ringEntries().length, 0, 'an answer records nothing')
})

test('an empty or absent answer stays a value', async () => {
    const worker = await start()
    assert.deepEqual(await storedRead(worker, 'listHandleOwners', undefined), {
        storedRead: 'value',
        storedValue: [],
    })
    assert.deepEqual(await storedRead(worker, 'readHandle', { chainId: 'c', role: 'kept' }), {
        storedRead: 'value',
        storedValue: undefined,
    })
    assert.deepEqual(await storedRead(worker, 'readChainRecord', 'none'), {
        storedRead: 'value',
        storedValue: undefined,
    })
})

test('a rejection is `failed`, recorded once, and the gate never rejects', async () => {
    const worker = await start()
    const read = await storedRead(worker, 'readHandle', { chainId: 'c', role: 'exportTarget' })
    assert.equal(read.storedRead, 'failed')
    assert.ok(read.storedRead === 'failed' && read.storedError instanceof Error)
    const recorded = ringEntries().filter((entry) => entry.text.includes('(gate test)'))
    assert.equal(recorded.length, 1)
    const pending = await storedRead(worker, 'openPendingImports', undefined)
    assert.equal(pending.storedRead, 'failed')
})

test('a worker that stopped for good is `failed` at once', async () => {
    const dead = { call: () => Promise.reject(new Error('The storage worker stopped')) }
    const read = await storedRead(dead, 'listRecovered', undefined)
    assert.equal(read.storedRead, 'failed')
})

test('over `connect`’s client, the same answers and failures', async () => {
    const worker = new FakeWorker()
    const client = connect<typeof handlers>(worker as never, {})
    assert.deepEqual(
        await storedRead(client as never, 'readChainRecord', 'c1'),
        readValue({ chainId: 'c1' }),
    )
    assert.equal(
        (await storedRead(client as never, 'openPendingImports', undefined)).storedRead,
        'failed',
    )
})

test('a wrapper maps a value and passes a failure on', () => {
    const value: StoredRead<number> = readValue(2)
    assert.deepEqual(
        mapRead(value, (n) => n * 2),
        readValue(4),
    )
    const failed: StoredRead<number> = { storedRead: 'failed', storedError: new Error('x') }
    assert.equal(
        mapRead(failed, () => assert.fail('a failure is not mapped')),
        failed,
    )
})
