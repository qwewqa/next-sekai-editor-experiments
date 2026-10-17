import assert from 'node:assert/strict'
import test from 'node:test'
import { CHANNEL_NAME } from '../../src/local/channel'
import { DB_NAME, hashKey, STORE_NAMES, STORES_V1 } from '../../src/local/db'
import { MemoryKv } from '../../src/local/kv/memory'
import { checkStored } from '../../src/local/testing/invariants'
import { crashSweep } from '../../src/local/testing/sweep'
import { CI_SEEDS, createWorld, type Tab, type World } from '../../src/local/testing/world'
import {
    StorageCore,
    StoragePausedError,
    StorageRefusedError,
    type CoreDeps,
    type TestFlags,
} from '../../src/local/worker/core'

// The upgrade handshake and the worker's storage states (§1.6.1, §1.6.7), with tabs on the test
// core. Timers are real but short: about 3 s in the build is 40 ms here.

let ids = 0

const core = (
    world: World,
    tab: Tab,
    flags: TestFlags = {},
    deps: Partial<CoreDeps> = {},
): StorageCore => {
    const fallback = new MemoryKv(world.scheduler)
    return new StorageCore({
        factory: tab.kv,
        memory: () => fallback.factory(tab.actor),
        channel: tab.channel(CHANNEL_NAME),
        locks: tab.locks,
        appVersion: '0.6.0',
        randomId: () => `id-${ids++}`,
        flags,
        blockedMs: 40,
        upgradeMs: 80,
        maintWaitMs: 40,
        ...deps,
    })
}

const putRow = (tab: Tab, store: StorageCore, key: string) =>
    tab.run(() => store.write(['meta'], (tx) => tx.put('meta', { key, value: tab.name })))

const getRow = (tab: Tab, store: StorageCore, key: string) =>
    tab.run(() => store.read(['meta'], (tx) => tx.get('meta', key)))

test('the first load creates every v1 store, index and meta row', async () => {
    const world = createWorld({ seed: 1 })
    const tab = world.tab('a')
    const store = core(world, tab, {}, { deviceId: 'device-1' })
    assert.deepEqual(await tab.run(() => store.start()), { mode: 'stored' })
    const schema = await tab.run(() =>
        store.read(STORE_NAMES, async (tx) => ({
            stores: Object.fromEntries(STORE_NAMES.map((name) => [name, tx.describe(name)])),
            meta: await tx.getAll('meta'),
        })),
    )
    for (const name of STORE_NAMES) {
        const spec = STORES_V1[name]
        assert.deepEqual(
            schema.stores[name],
            { keyPath: spec.keyPath, indexes: spec.indexes },
            name,
        )
    }
    const meta = Object.fromEntries(
        (schema.meta as { key: string; value: unknown }[]).map((row) => [row.key, row.value]),
    )
    assert.deepEqual(Object.keys(meta).sort(), [
        'createdBy',
        'daysOfUse',
        'dbInstanceId',
        'deletionsPending',
        'deviceId',
        'epoch',
        'formatVersion',
        'lastGcAt',
        'lastPersistFailure',
        'lastUseDate',
        'maxSeenTime',
        'migratedHashes',
        'usage',
    ])
    assert.equal(meta.formatVersion, 1)
    assert.equal(meta.createdBy, '0.6.0')
    assert.equal(meta.epoch, 0)
    assert.equal(meta.deviceId, 'device-1')
    assert.equal(world.memory.version(DB_NAME), 1)
    await world.idle()
})

test('a second v1 tab opens the same database at the same version', async () => {
    for (const seed of CI_SEEDS) {
        const world = createWorld({ seed })
        const a = world.tab('a')
        const b = world.tab('b')
        const [storeA, storeB] = [core(world, a), core(world, b)]
        const [statusA, statusB] = await Promise.all([
            a.run(() => storeA.start()),
            b.run(() => storeB.start()),
        ])
        assert.deepEqual([statusA, statusB], [{ mode: 'stored' }, { mode: 'stored' }])
        await putRow(a, storeA, 'x')
        assert.deepEqual(await getRow(b, storeB, 'x'), { key: 'x', value: 'a' })
        await world.idle()
    }
})

test('a v2 tab: the v1 tab answers upgradeWanted and onversionchange, closes and pauses', async () => {
    for (const seed of CI_SEEDS) {
        const world = createWorld({ seed })
        const old = world.tab('old')
        const oldStore = core(world, old)
        await old.run(() => oldStore.start())
        const next = world.tab('next')
        const nextStore = core(world, next, { dbVersion: 2 })
        assert.deepEqual(await next.run(() => nextStore.start()), { mode: 'stored' })
        assert.equal(world.memory.version(DB_NAME), 2)
        assert.deepEqual(oldStore.status, { mode: 'stored', reason: 'upgrading' })
        await assert.rejects(putRow(old, oldStore, 'late'), StorageRefusedError)
        // The broadcast went out before the version was requested.
        assert.ok(
            world.channels.posted.some(
                (post) =>
                    post.from === 'next' && (post.message as { version: number }).version === 2,
            ),
        )
        await putRow(next, nextStore, 'x')
        await world.idle()
    }
})

test('upgradeWanted alone closes a v1 tab’s connection and pauses its storing', async () => {
    const world = createWorld({ seed: 4 })
    const old = world.tab('old')
    const oldStore = core(world, old)
    await old.run(() => oldStore.start())
    world.tab('other').channel(CHANNEL_NAME).post({ type: 'upgradeWanted', version: 2 })
    await world.idle()
    assert.deepEqual(oldStore.status, { mode: 'stored', reason: 'upgrading' })
    // A message for the version it already has asks nothing.
    const fresh = world.tab('fresh')
    const freshStore = core(world, fresh)
    await fresh.run(() => freshStore.start())
    world.tab('other2').channel(CHANNEL_NAME).post({ type: 'upgradeWanted', version: 1 })
    await world.idle()
    assert.deepEqual(freshStore.status, { mode: 'stored' })
})

test('onversionchange alone closes a v1 tab’s connection, letting the transaction in flight finish', async () => {
    for (const seed of CI_SEEDS) {
        const world = createWorld({ seed })
        const old = world.tab('old')
        const oldStore = core(world, old)
        await old.run(() => oldStore.start())
        const next = world.tab('next')
        // A channel nobody listens on: the broadcast is lost, as for a page frozen at the time.
        const nextStore = core(
            world,
            next,
            { dbVersion: 2 },
            { channel: next.channel('elsewhere') },
        )
        let starting: Promise<unknown> | undefined
        await old.run(() =>
            oldStore.write(['meta'], async (tx) => {
                await tx.put('meta', { key: 'inFlight', value: 1 })
                starting ??= next.run(() => nextStore.start())
                for (let i = 0; i < 5; i++) await tx.put('meta', { key: 'inFlight', value: i })
            }),
        )
        await starting
        await world.idle()
        assert.deepEqual(oldStore.status, { mode: 'stored', reason: 'upgrading' }, `seed ${seed}`)
        assert.deepEqual(nextStore.status, { mode: 'stored' })
        assert.deepEqual(await getRow(next, nextStore, 'inFlight'), { key: 'inFlight', value: 4 })
    }
})

test('a frozen tab leaves a v2 tab with storage unavailable after about 3 s; Try Again never hangs', async () => {
    const world = createWorld({ seed: 7 })
    const frozen = world.tab('frozen')
    const frozenStore = core(world, frozen, { ignoreVersionChange: true })
    await frozen.run(() => frozenStore.start())
    const next = world.tab('next')
    const nextStore = core(world, next, { dbVersion: 2 })
    const started = Date.now()
    assert.deepEqual(await next.run(() => nextStore.start()), {
        mode: 'memory',
        reason: 'olderTabs',
    })
    assert.ok(Date.now() - started < 2000)
    // Storage unavailable: the tab works in memory.
    await next.run(() =>
        nextStore.write(['recovered'], (tx) => tx.put('recovered', { id: 'kept', source: 'test' })),
    )
    assert.deepEqual(await next.run(() => nextStore.tryAgain()), {
        mode: 'memory',
        reason: 'olderTabs',
    })
    assert.deepEqual(frozenStore.status, { mode: 'stored' })
    // Once the frozen tab goes, Try Again opens the database and keeps what was stored in memory.
    frozen.kill()
    await world.scheduler.idle()
    assert.deepEqual(await next.run(() => nextStore.tryAgain()), { mode: 'stored' })
    assert.equal(world.memory.version(DB_NAME), 2)
    const stored = world.memory.dump(DB_NAME).get('recovered') ?? []
    assert.deepEqual(
        stored.map((row) => row.key),
        ['kept'],
    )
    await world.idle()
})

test('a v1 tab loading behind a blocked upgrade gives up in time too, and opens once it clears', async () => {
    const world = createWorld({ seed: 13 })
    const frozen = world.tab('frozen')
    const frozenStore = core(world, frozen, { ignoreVersionChange: true })
    await frozen.run(() => frozenStore.start())
    const next = world.tab('next')
    const nextStore = core(world, next, { dbVersion: 2 })
    await next.run(() => nextStore.start())
    // Its versionless open waits in the queue behind the pending upgrade.
    const late = world.tab('late')
    const lateStore = core(world, late)
    assert.deepEqual(await late.run(() => lateStore.start()), {
        mode: 'memory',
        reason: 'olderTabs',
    })
    frozen.kill()
    await world.scheduler.idle()
    // The upgrade went through meanwhile: this build is now older than the database.
    assert.deepEqual(await late.run(() => lateStore.tryAgain()), { mode: 'readOnly' })
    assert.deepEqual(await next.run(() => nextStore.tryAgain()), { mode: 'stored' })
    await world.idle()
})

test('a tab older than the database opens it read-only', async () => {
    const world = createWorld({ seed: 8 })
    const next = world.tab('next')
    const nextStore = core(world, next, { dbVersion: 3 })
    await next.run(() => nextStore.start())
    await putRow(next, nextStore, 'x')
    next.kill()
    const old = world.tab('old')
    const oldStore = core(world, old)
    assert.deepEqual(await old.run(() => oldStore.start()), { mode: 'readOnly' })
    assert.deepEqual(await getRow(old, oldStore, 'x'), { key: 'x', value: 'next' })
    await assert.rejects(putRow(old, oldStore, 'y'), StorageRefusedError)
    assert.equal(world.memory.version(DB_NAME), 3)
})

test('no storage at all runs in memory', async () => {
    const world = createWorld({ seed: 9 })
    const tab = world.tab('a')
    for (const store of [
        core(world, tab, { noStorage: true }),
        core(world, tab, {}, { factory: undefined }),
    ]) {
        assert.deepEqual(await tab.run(() => store.start()), { mode: 'memory' })
        await putRow(tab, store, 'x')
        assert.deepEqual(await getRow(tab, store, 'x'), { key: 'x', value: 'a' })
    }
    assert.equal(world.memory.version(DB_NAME), 0)
})

test('a lost connection is reopened and the write retried once', async () => {
    const world = createWorld({ seed: 10 })
    const tab = world.tab('a')
    const store = core(world, tab)
    await tab.run(() => store.start())
    world.memory.loseConnections(DB_NAME)
    await world.scheduler.idle()
    await putRow(tab, store, 'after')
    assert.deepEqual(store.status, { mode: 'stored' })
    // Lost in the middle of a write: retried on a new connection.
    let runs = 0
    await tab.run(() =>
        store.write(['meta'], async (tx) => {
            runs++
            await tx.put('meta', { key: 'mid', value: runs })
            if (runs === 1) world.memory.loseConnections(DB_NAME)
            await tx.put('meta', { key: 'mid2', value: runs })
        }),
    )
    assert.equal(runs, 2)
    assert.deepEqual(await getRow(tab, store, 'mid2'), { key: 'mid2', value: 2 })
})

test('failures pause storing with their reason; the next write that succeeds resumes it', async () => {
    const world = createWorld({ seed: 11 })
    const tab = world.tab('a')
    const flags: TestFlags = { forceQuota: true }
    const quota = 10e9
    let usage = 1e6
    const store = core(world, tab, flags, {
        estimate: () => Promise.resolve({ usage, quota }),
    })
    await tab.run(() => store.start())
    const paused = await putRow(tab, store, 'x').catch((error: unknown) => error)
    assert.ok(paused instanceof StoragePausedError)
    assert.deepEqual(store.status, { mode: 'stored', reason: 'full' })
    flags.forceQuota = false
    flags.forceUnknownError = true
    await assert.rejects(putRow(tab, store, 'x'), StoragePausedError)
    assert.deepEqual(store.status, { mode: 'stored', reason: 'failed' })
    // UnknownError with little free space is a full disk.
    usage = quota - 1e6
    await assert.rejects(putRow(tab, store, 'x'), StoragePausedError)
    assert.deepEqual(store.status, { mode: 'stored', reason: 'full' })
    flags.forceUnknownError = false
    await putRow(tab, store, 'x')
    assert.deepEqual(store.status, { mode: 'stored' })
    assert.deepEqual(await getRow(tab, store, 'x'), { key: 'x', value: 'a' })
})

test('a write waits at most about 3 s for nse-maint, then counts as paused', async () => {
    const world = createWorld({ seed: 12 })
    const tab = world.tab('a')
    const maint = world.tab('maint')
    const store = core(world, tab)
    await tab.run(() => store.start())
    let release!: () => void
    void maint.run(() =>
        maint.locks.request(
            'nse-maint',
            { mode: 'exclusive' },
            () => new Promise<void>((r) => (release = r)),
        ),
    )
    await world.scheduler.idle()
    await assert.rejects(putRow(tab, store, 'x'), StoragePausedError)
    assert.deepEqual(store.status, { mode: 'stored', reason: 'failed' })
    release()
    await putRow(tab, store, 'x')
    assert.deepEqual(store.status, { mode: 'stored' })
})

const hash = (n: number) => new Uint8Array(16).fill(n)

test('a write killed at any await leaves all of it or none, and its lock released', async () => {
    await crashSweep({
        seeds: [undefined, ...CI_SEEDS.slice(0, 2)],
        setup: async (world) => {
            const tab = world.tab('setup')
            const store = core(world, tab)
            await tab.run(() => store.start())
        },
        scenario: async ({ world, victim }) => {
            const store = core(world, victim)
            await victim.run(() => store.start())
            await victim.run(() =>
                store.write(['chains', 'sessions', 'entries', 'nodes', 'meta'], async (tx) => {
                    await tx.put('nodes', { t: 'root', refs: new Uint8Array() }, hashKey(hash(1)))
                    await tx.put('sessions', { id: 's', chainId: 'c' })
                    await tx.put('chains', { chainId: 'c', head: 's' })
                    await tx.put('entries', {
                        sessionId: 's',
                        seq: 0,
                        snapshot: hash(1),
                        kept: true,
                    })
                }),
            )
        },
        recover: async ({ world }) => {
            const tab = world.tab('next load')
            const store = core(world, tab)
            await tab.run(() => store.start())
            await putRow(tab, store, 'after')
        },
        check: ({ world }) => {
            assert.deepEqual(checkStored(world.memory), [])
            const chains = world.memory.dump(DB_NAME).get('chains') ?? []
            const entries = world.memory.dump(DB_NAME).get('entries') ?? []
            assert.equal(chains.length, entries.length)
            assert.deepEqual(world.locks.snapshot(), { held: [], pending: [] })
        },
    })
})
