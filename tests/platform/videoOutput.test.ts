import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openStagedTarget } from '../../src/editor/exportVideo/worker/target'
import { FakeLockManager } from '../../src/local/testing/locks'
import { BLOB_URL_MS } from '../../src/platform/handover'
import { memoryVideoStore } from '../../src/platform/mockVideoOutput'
import { createVideoOutput, videoLock } from '../../src/platform/videoOutput'

const setup = () => {
    const manager = new FakeLockManager()
    const locks = manager.client(manager.scheduler.main)
    const store = memoryVideoStore()
    const timers = new Map<unknown, () => void>()
    let delivery: 'delivered' | 'cancelled' | 'failed' = 'delivered'
    const output = createVideoOutput(
        store,
        locks,
        {
            canShare: () => true,
            deliver: async () => {
                if (delivery === 'failed') throw new Error('Delivery failed')
                return delivery
            },
        },
        {
            setTimeout: (fn, ms) => {
                assert.equal(ms, BLOB_URL_MS)
                const id = {}
                timers.set(id, fn)
                return id
            },
            clearTimeout: (id) => {
                timers.delete(id)
            },
        },
    )
    return {
        output,
        store,
        manager,
        timers,
        delivery: (value: typeof delivery) => {
            delivery = value
        },
    }
}

for (const operation of ['file', 'remove'] as const)
    test(`a staged ${operation} failure retains its FileError code`, async (t) => {
        const w = setup()
        await w.output.stage('failed', 'webm')
        t.mock.method(w.store, operation, () => {
            throw new DOMException('Denied', 'NotAllowedError')
        })
        try {
            await assert.rejects(w.output[operation]('failed'), { code: 'denied' })
        } finally {
            t.mock.restoreAll()
            await w.output.remove('failed')
        }
    })

test('a delivered video stays locked throughout Ready and for ten minutes after Ready ends', async () => {
    const w = setup()
    const staged = await w.output.stage('ready', 'mp4')
    const target = await openStagedTarget(staged.handle)
    await target.write(new Uint8Array([1, 2, 3]), 0)
    await target.close()
    const file = await w.output.file('ready')
    await w.output.deliver(file, 'clip.mp4', 'download')
    assert.equal(w.timers.size, 0, 'delivery does not start the retention timer')
    await w.output.sweep()
    assert.equal((await w.output.file('ready')).size, 3)
    await w.output.deliver(file, 'again.mp4', 'download')
    await staged.endReady()
    assert.equal(w.timers.size, 1)
    await w.output.sweep()
    assert.equal((await w.store.file('ready.mp4')).size, 3)
    assert.ok(w.manager.snapshot().held.some((lock) => lock.name === videoLock('ready')))
    for (const fn of w.timers.values()) fn()
    // The same lock is the completion signal for deletion, not a timer delay.
    await w.manager
        .client(w.manager.scheduler.actor('observer'))
        .request(videoLock('ready'), {}, async () => {
            assert.deepEqual(await w.store.names(), [])
        })
})

test('dismissed shares and failed delivery keep Ready available; discarding removes it', async () => {
    const w = setup()
    const staged = await w.output.stage('share', 'webm')
    const file = await w.output.file('share')
    w.delivery('cancelled')
    assert.equal(await w.output.deliver(file, 'clip.webm', 'share'), 'cancelled')
    w.delivery('failed')
    await assert.rejects(w.output.deliver(file, 'clip.webm', 'download'))
    assert.equal((await w.output.file('share')).size, 0)
    await staged.endReady()
    assert.deepEqual(await w.store.names(), [])
    assert.equal(w.timers.size, 0)
})

test('sweep removes an orphan and skips a file held by another page', async () => {
    const w = setup()
    await w.store.create('orphan.mp4')
    await w.store.create('unrecognized')
    const active = await w.output.stage('active', 'webm')
    const other = createVideoOutput(w.store, w.manager.client(w.manager.scheduler.actor('other')), {
        canShare: () => false,
        deliver: () => Promise.resolve('delivered'),
    })
    await other.sweep()
    assert.deepEqual((await w.store.names()).sort(), ['active.webm', 'unrecognized'])
    await assert.rejects(other.stage('active', 'mp4'), /in use/)
    await active.endReady()
    assert.deepEqual(await w.store.names(), ['unrecognized'])
})

test('a collision never truncates an existing staged file and releases the job lock', async () => {
    const w = setup()
    const handle = await w.store.create('collision.mp4')
    const target = await openStagedTarget(handle)
    await target.write(new Uint8Array([9]), 0)
    await target.close()
    await assert.rejects(w.output.stage('collision', 'mp4'), /already exists/)
    assert.equal((await w.store.file('collision.mp4')).size, 1)
    await w.output.sweep()
    assert.deepEqual(await w.store.names(), [])
})

test('a sweep retries a failed deletion after retention expires', async (t) => {
    const w = setup()
    const staged = await w.output.stage('expired', 'mp4')
    const file = await w.output.file('expired')
    await w.output.deliver(file, 'clip.mp4', 'download')
    await staged.endReady()
    const removal = t.mock.method(
        w.store,
        'remove',
        async () => {
            throw new Error('Removal failed')
        },
        { times: 1 },
    )
    for (const fn of w.timers.values()) fn()
    assert.deepEqual(await w.store.names(), ['expired.mp4'])
    assert.equal(removal.mock.callCount(), 1)
    const locks = await w.manager.client(w.manager.scheduler.actor('observer')).query()
    assert.ok(!locks.held.some((lock) => lock.name === videoLock('expired')))
    await w.output.sweep()
    assert.deepEqual(await w.store.names(), [])
    await assert.rejects(w.output.deliver(file, 'clip.mp4', 'download'), /no longer ready/)
})

test('a sweep retries a failed deletion after discarding an undelivered video', async (t) => {
    const w = setup()
    const staged = await w.output.stage('discard', 'webm')
    t.mock.method(
        w.store,
        'remove',
        async () => {
            throw new Error('Removal failed')
        },
        { times: 1 },
    )
    await assert.rejects(staged.endReady(), /Removal failed/)
    assert.deepEqual(await w.store.names(), ['discard.webm'])
    await staged.endReady()
    await w.output.sweep()
    assert.deepEqual(await w.store.names(), [])
})

for (const end of ['cancel', 'failure'] as const)
    test(`a sweep retries a failed deletion after a ${end === 'cancel' ? 'cancelled' : 'failed'} export`, async (t) => {
        const w = setup()
        const staged = await w.output.stage(end, 'mp4')
        const target = await openStagedTarget(staged.handle)
        await target.write(new Uint8Array([1, 2, 3]), 0)
        if (end === 'cancel') await target.abort()
        else await assert.rejects(target.write(new Uint8Array([4]), -1))
        t.mock.method(
            w.store,
            'remove',
            async () => {
                throw new Error('Removal failed')
            },
            { times: 1 },
        )
        await assert.rejects(w.output.remove(end), /Removal failed/)
        assert.deepEqual(await w.store.names(), [`${end}.mp4`])
        await w.output.sweep()
        assert.deepEqual(await w.store.names(), [])
        await assert.rejects(w.output.file(end), /no longer ready/)
    })

test('a sweep releases its lock after a failed deletion and retries on the next sweep', async (t) => {
    const w = setup()
    await w.store.create('orphan.mp4')
    t.mock.method(
        w.store,
        'remove',
        async () => {
            throw new Error('Removal failed')
        },
        { times: 1 },
    )
    await assert.rejects(w.output.sweep(), /Removal failed/)
    assert.deepEqual(await w.store.names(), ['orphan.mp4'])
    await w.output.sweep()
    assert.deepEqual(await w.store.names(), [])
})
