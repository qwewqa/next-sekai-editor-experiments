import assert from 'node:assert/strict'
import test from 'node:test'
import { hashKey } from '../../../src/local/db'
import type { KvDatabase } from '../../../src/local/kv/types'
import { withMaintExclusive, withMaintShared } from '../../../src/local/locks'
import { openLocalData } from '../../../src/local/testing/db'
import { checkStored } from '../../../src/local/testing/invariants'
import { crashSweep } from '../../../src/local/testing/sweep'
import { CI_SEEDS, createWorld, type Tab } from '../../../src/local/testing/world'

// The test core: what breaks in browsers breaks here too.

const failureOf = (promise: Promise<unknown>) =>
    promise.then(
        () => undefined,
        (error: unknown) => error as Error,
    )

test('code that awaits crypto.subtle inside a transaction fails in Node', async () => {
    for (const seed of [undefined, ...CI_SEEDS]) {
        const world = createWorld({ seed })
        const tab = world.tab('a')
        const db = await openLocalData(tab)
        const failure = await failureOf(
            tab.run(() =>
                db.transaction(['meta'], 'readwrite', async (tx) => {
                    await tx.get('meta', 'epoch')
                    await crypto.subtle.digest('SHA-256', new Uint8Array(8))
                    await tx.put('meta', { key: 'late', value: 1 })
                }),
            ),
        )
        assert.equal(failure?.name, 'TransactionInactiveError', `seed ${String(seed)}`)
        await world.idle()
    }
})

test('a Blob read or a timer inside a transaction fails too; its own requests never do', async () => {
    const world = createWorld({ seed: 1 })
    const tab = world.tab('a')
    const db = await openLocalData(tab)
    const outside = [
        () => new Blob([new Uint8Array(4)]).arrayBuffer(),
        () => new Promise((resolve) => setTimeout(resolve, 0)),
    ]
    for (const wait of outside) {
        const failure = await failureOf(
            tab.run(() =>
                db.transaction(['meta'], 'readwrite', async (tx) => {
                    await tx.get('meta', 'epoch')
                    await wait()
                    await tx.put('meta', { key: 'late', value: 1 })
                }),
            ),
        )
        assert.equal(failure?.name, 'TransactionInactiveError')
    }
    // A chain of the transaction's own requests, and plain promise steps between them, is fine.
    const value = await tab.run(() =>
        db.transaction(['meta'], 'readwrite', async (tx) => {
            for (let i = 0; i < 20; i++) {
                await tx.put('meta', { key: 'count', value: i })
                await Promise.resolve()
            }
            return tx.get('meta', 'count')
        }),
    )
    assert.deepEqual(value, { key: 'count', value: 19 })
})

/** Four read-modify-write steps on one row, in one transaction created now. */
const write = (db: KvDatabase, log: string[], name: string) =>
    db.transaction(['meta'], 'readwrite', async (tx) => {
        for (let i = 0; i < 4; i++) {
            const row = (await tx.get('meta', 'shared')) as { value: string[] } | undefined
            log.push(`${name}${i}`)
            await tx.put('meta', { key: 'shared', value: [...(row?.value ?? []), `${name}${i}`] })
        }
    })

test('overlapping writes from two tabs run in creation order', async () => {
    for (const seed of CI_SEEDS) {
        const world = createWorld({ seed })
        const a = world.tab('a')
        const b = world.tab('b')
        const dbA = await openLocalData(a)
        const dbB = await openLocalData(b)
        const log: string[] = []
        // B creates its transaction while A's first is under way, then A creates another.
        const first = a.run(() => {
            const started = write(dbA, log, 'a')
            void b.run(() => write(dbB, log, 'b'))
            return started
        })
        await first
        await world.idle()
        assert.deepEqual(log, ['a0', 'a1', 'a2', 'a3', 'b0', 'b1', 'b2', 'b3'], `seed ${seed}`)
        const stored = await b.run(() =>
            dbB.transaction(['meta'], 'readonly', (tx) => tx.get('meta', 'shared')),
        )
        assert.deepEqual((stored as { value: string[] }).value, log)
    }
})

test('a read-only transaction created after a write waits for it, under every seed', async () => {
    for (const seed of CI_SEEDS) {
        const world = createWorld({ seed })
        const a = world.tab('a')
        const b = world.tab('b')
        const dbA = await openLocalData(a)
        const dbB = await openLocalData(b)
        const log: string[] = []
        let read: unknown
        await a.run(() => {
            const writing = write(dbA, log, 'a')
            void b.run(async () => {
                read = await dbB.transaction(['meta'], 'readonly', (tx) => tx.get('meta', 'shared'))
            })
            return writing
        })
        await world.idle()
        assert.deepEqual((read as { value: string[] }).value, ['a0', 'a1', 'a2', 'a3'])
    }
})

/** A maintenance or build job of several short transactions. */
const batches = async (db: KvDatabase, log: string[], name: string, count: number) => {
    for (let i = 0; i < count; i++) {
        await db.transaction(['meta'], 'readwrite', async (tx) => {
            await tx.put('meta', { key: name, value: i })
        })
        log.push(`${name}${i}`)
    }
}

test('a build holds nse-maint shared, a sweep asks exclusive with ifAvailable: a flush never waits', async () => {
    for (const seed of CI_SEEDS) {
        const world = createWorld({ seed })
        const [build, sweep, flush] = ['build', 'sweep', 'flush'].map((name) => world.tab(name))
        const [dbBuild, , dbFlush] = await Promise.all(
            [build, sweep, flush].map((tab) => openLocalData(tab!)),
        )
        const log: string[] = []
        let buildDone!: () => void
        const buildRelease = new Promise<void>((resolve) => (buildDone = resolve))
        // The build's read phase holds the lock shared until released.
        void build!.run(() =>
            withMaintShared(build!.locks, async () => {
                log.push('build')
                await buildRelease
            }),
        )
        await world.scheduler.idle()
        const swept = await sweep!.run(() =>
            withMaintExclusive(sweep!.locks, async () => {
                log.push('sweep')
            }),
        )
        assert.equal(swept.ran, false, 'the sweep backs off')
        await flush!.run(() =>
            withMaintShared(flush!.locks, () => batches(dbFlush!, log, 'flush', 1)),
        )
        assert.deepEqual(log, ['build', 'flush0'], `seed ${seed}`)
        buildDone()
        await world.idle()
        void dbBuild
    }
})

test('a flush asking while a sweep holds nse-maint waits one batch at most', async () => {
    for (const seed of CI_SEEDS) {
        const world = createWorld({ seed })
        const sweep = world.tab('sweep')
        const flush = world.tab('flush')
        const dbSweep = await openLocalData(sweep)
        const dbFlush = await openLocalData(flush)
        const log: string[] = []
        // The sweep releases between batches and asks again with ifAvailable.
        const sweeping = sweep.run(async () => {
            for (let batch = 0; batch < 4; batch++) {
                const result = await withMaintExclusive(sweep.locks, async () => {
                    log.push(`sweep${batch}`)
                    if (batch === 0)
                        void flush.run(() =>
                            withMaintShared(flush.locks, async () => {
                                log.push('flush')
                                await batches(dbFlush, [], 'flush', 1)
                            }),
                        )
                    await batches(dbSweep, [], 'sweep', 2)
                })
                if (!result.ran) log.push(`backoff${batch}`)
            }
        })
        await sweeping
        await world.idle()
        const flushAt = log.indexOf('flush')
        const sweptBefore = log.slice(0, flushAt).filter((item) => item.startsWith('sweep'))
        assert.ok(flushAt >= 0, `seed ${seed}: ${log.join(' ')}`)
        assert.ok(sweptBefore.length <= 1, `seed ${seed}: ${log.join(' ')}`)
    }
})

test('a queued exclusive request without ifAvailable would stall the flush behind the build', async () => {
    const world = createWorld({ seed: 1 })
    const [build, sweep, flush] = ['build', 'sweep', 'flush'].map((name) => world.tab(name))
    const log: string[] = []
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    void build!.run(() =>
        build!.locks.request('nse-maint', { mode: 'shared' }, async () => {
            log.push('build')
            await held
            log.push('build done')
        }),
    )
    await world.scheduler.idle()
    void sweep!.run(() =>
        sweep!.locks.request('nse-maint', { mode: 'exclusive' }, async () => {
            log.push('sweep')
        }),
    )
    void flush!.run(() =>
        flush!.locks.request('nse-maint', { mode: 'shared' }, async () => {
            log.push('flush')
        }),
    )
    await world.scheduler.idle()
    assert.deepEqual(log, ['build'])
    release()
    await world.idle()
    assert.deepEqual(log, ['build', 'build done', 'sweep', 'flush'])
})

// A toy writer: a chain, its session, a root node and an entry pointing at it.
const hash = (n: number) => new Uint8Array(16).fill(n)

const writeAtomic = (tab: Tab, db: KvDatabase) =>
    tab.run(() =>
        db.transaction(['chains', 'sessions', 'entries', 'nodes'], 'readwrite', async (tx) => {
            await tx.put('nodes', { t: 'root', refs: new Uint8Array() }, hashKey(hash(1)))
            await tx.put('sessions', { id: 's', chainId: 'c' })
            await tx.put('chains', { chainId: 'c', head: 's' })
            await tx.put('entries', { sessionId: 's', seq: 0, snapshot: hash(1), kept: true })
        }),
    )

const writeSplit = async (tab: Tab, db: KvDatabase) => {
    await tab.run(() =>
        db.transaction(['chains', 'sessions', 'entries'], 'readwrite', async (tx) => {
            await tx.put('sessions', { id: 's', chainId: 'c' })
            await tx.put('chains', { chainId: 'c', head: 's' })
            await tx.put('entries', { sessionId: 's', seq: 0, snapshot: hash(1), kept: true })
        }),
    )
    await tab.run(() =>
        db.transaction(['nodes'], 'readwrite', (tx) =>
            tx.put('nodes', { t: 'root', refs: new Uint8Array() }, hashKey(hash(1))),
        ),
    )
}

test('the crash-at-every-await sweep passes an atomic writer and catches a split one', async () => {
    const seeds = [undefined, ...CI_SEEDS.slice(0, 3)]
    const atomic = await crashSweep({
        checks: false,
        seeds,
        scenario: async ({ victim }) => {
            await writeAtomic(victim, await openLocalData(victim))
        },
        check: ({ world }) => {
            assert.deepEqual(checkStored(world.memory, { replay: false }), [])
        },
    })
    assert.ok(atomic.every((run) => run.points > 4))

    const found: number[] = []
    await crashSweep({
        checks: false,
        seeds: [undefined],
        scenario: async ({ victim }) => {
            await writeSplit(victim, await openLocalData(victim))
        },
        check: ({ world, killedAt }) => {
            if (checkStored(world.memory, { replay: false }).length) found.push(killedAt!)
        },
    })
    assert.ok(found.length > 0, 'a kill between the two transactions leaves a dangling entry')
})

test("a killed tab's locks go to the next in line, and its pending requests go with it", async () => {
    const world = createWorld({ seed: 3 })
    const a = world.tab('a')
    const b = world.tab('b')
    const c = world.tab('c')
    const log: string[] = []
    void a.run(() =>
        a.locks.request('x', {}, async () => {
            log.push('a')
            await new Promise(() => undefined)
        }),
    )
    await world.scheduler.idle()
    void b.run(() => b.locks.request('x', {}, async () => log.push('b')))
    void c.run(() => c.locks.request('x', { mode: 'shared' }, async () => log.push('c')))
    await world.scheduler.idle()
    const snapshot = await c.run(() => c.locks.query())
    assert.deepEqual(
        snapshot.pending.map((lock) => `${lock.clientId}:${lock.mode}`),
        ['b:exclusive', 'c:shared'],
    )
    assert.deepEqual(
        snapshot.held.map((lock) => lock.clientId),
        ['a'],
    )
    b.kill()
    a.kill()
    await world.idle()
    assert.deepEqual(log, ['a', 'c'])
})

test('an aborted lock request leaves the queue', async () => {
    const world = createWorld({ seed: 2 })
    const a = world.tab('a')
    const b = world.tab('b')
    let release!: () => void
    void a.run(() =>
        a.locks.request('x', {}, () => new Promise<void>((resolve) => (release = resolve))),
    )
    await world.scheduler.idle()
    const controller = new AbortController()
    const waiting = b.run(() =>
        b.locks.request('x', { signal: controller.signal }, async () => 'got'),
    )
    await world.scheduler.idle()
    controller.abort()
    await assert.rejects(waiting, { name: 'AbortError' })
    release()
    await world.idle()
    assert.deepEqual(world.locks.snapshot(), { held: [], pending: [] })
})
