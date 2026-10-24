import assert from 'node:assert/strict'
import test from 'node:test'
import type { UseDay } from '../../../src/local/days'
import { DB_NAME, hashKey, writeMeta } from '../../../src/local/db'
import { gcPass } from '../../../src/local/gc'
import { toHex } from '../../../src/local/hash'
import { importLock, MAINT_LOCK } from '../../../src/local/locks'
import { packHashes } from '../../../src/local/records/rows'
import { RECORDS_V, SESSION_V } from '../../../src/local/records/version'
import { checkStored } from '../../../src/local/testing/invariants'
import { createWorld, type World } from '../../../src/local/testing/world'
import type { StorageCore } from '../../../src/local/worker/core'
import { editStep, futureFixtureOperation, originOperation } from '../../helpers/historySteps'
import { openPage, rows, storedRecords, testId, workerCore } from '../flush/harness'
import { goldenChart, stateOf } from '../records/charts'
import { sampleState } from '../records/samples'
import { closedChain, daysPass, MemoryStorage, openDeleter, tamper } from './harness'

// GC: mark from entries, recovered pushes and stack blocks through `refs`,
// sweep the rest past the grace period, one epoch bump per deleting transaction, stop for a
// waiting writer, and remove nothing while a newer build's data is in use.

let made = 0
const hash = () => {
    const bytes = new Uint8Array(16)
    bytes[0] = 0xa0
    new DataView(bytes.buffer).setUint32(4, ++made)
    return bytes
}

const DAYS = 10 as UseDay

/** A profile's bodies, each named, with what references them; `day` 1 unless said. */
const seedBodies = async (world: World) => {
    const h = {
        root: hash(),
        headerChunk: hash(),
        node: hash(),
        nodeChunk: hash(),
        media: hash(),
        pushed: hash(),
        slot: hash(),
        orphanChunk: hash(),
        orphanNode: hash(),
        orphanNodeChunk: hash(),
        orphanMedia: hash(),
        fresh: hash(),
        undated: hash(),
    }
    const chunk = (day?: number) => ({
        bytes: new Uint8Array([1]),
        size: 1,
        crc32: 0,
        ...(day === undefined ? {} : { day }),
    })
    await tamper(world, async (tx) => {
        await writeMeta(tx, 'daysOfUse', DAYS)
        await tx.put(
            'nodes',
            {
                t: 'root',
                v: RECORDS_V,
                kinds: ['k'],
                noteCount: 0,
                size: 1,
                day: 1,
                refs: packHashes([h.headerChunk, h.node, h.media]),
            },
            hashKey(h.root),
        )
        await tx.put(
            'nodes',
            { t: 'node', kind: 'k', depth: 0, size: 1, day: 1, refs: packHashes([h.nodeChunk]) },
            hashKey(h.node),
        )
        await tx.put(
            'nodes',
            {
                t: 'node',
                kind: 'k',
                depth: 0,
                size: 1,
                day: 1,
                refs: packHashes([h.orphanNodeChunk]),
            },
            hashKey(h.orphanNode),
        )
        for (const key of [
            h.headerChunk,
            h.nodeChunk,
            h.pushed,
            h.slot,
            h.orphanChunk,
            h.orphanNodeChunk,
        ])
            await tx.put('chunks', chunk(1), hashKey(key))
        await tx.put('chunks', chunk(DAYS - 1), hashKey(h.fresh))
        await tx.put('chunks', chunk(), hashKey(h.undated))
        for (const key of [h.media, h.orphanMedia])
            await tx.put('media', { size: 1, kind: 'cover', day: 1 }, hashKey(key))
        await tx.put('entries', {
            sessionId: 's',
            seq: 1,
            kind: 'recovered',
            snapshot: h.root,
            stack: { keep: 0, push: [{ snapshot: h.pushed }], index: 0 },
        })
        await tx.put('stackBlocks', {
            sessionId: 's',
            block: 0,
            first: 0,
            hashes: packHashes([h.slot]),
            steps: [],
        })
    })
    return h
}

const bodies = (world: World) =>
    new Set(
        (['nodes', 'chunks', 'media'] as const).flatMap((store) =>
            (world.memory.dump(DB_NAME).get(store) ?? []).map((row) =>
                toHex(new Uint8Array(row.key as ArrayBuffer)),
            ),
        ),
    )

const meta = (world: World, key: string) => rows(world, 'meta').get(key)?.value

/** A core whose exclusive hold reports a waiting writer after `looks` looks for one. */
const waitingAfter = (deleter: Awaited<ReturnType<typeof fresh>>['deleter'], looks: number) => {
    let asked = 0
    const waiting = Object.create(deleter.core) as StorageCore
    waiting.exclusive = (body) =>
        deleter.core.exclusive((hold) =>
            body({ ...hold, writerWaiting: () => Promise.resolve(++asked > looks) }),
        )
    return waiting
}

const fresh = async (seed: number) => {
    const world = createWorld({ seed, checks: false })
    const deleter = await openDeleter(world, world.tab('gc'), new MemoryStorage())
    return { world, deleter }
}

test('GC keeps every body a row reaches through refs and the grace period, and sweeps the rest with one epoch bump', async () => {
    const { world, deleter } = await fresh(1)
    const h = await seedBodies(world)
    await tamper(world, async (tx) => {
        await tx.put('userAssets', { key: 'skin', type: 'skin', day: 1 })
    })
    const requested = new Set<string>()
    world.memory.faults.request = (stores) => {
        for (const store of stores) requested.add(store)
        return undefined
    }
    const epoch = meta(world, 'epoch') as number
    assert.deepEqual(await deleter.gc(), { kind: 'done', swept: 4 })
    world.memory.faults.request = undefined
    const left = bodies(world)
    for (const name of ['orphanChunk', 'orphanNode', 'orphanNodeChunk', 'orphanMedia'] as const)
        assert.ok(!left.has(toHex(h[name])), name)
    for (const name of [
        'root',
        'headerChunk',
        'node',
        'nodeChunk',
        'media',
        'pushed',
        'slot',
        'fresh',
        'undated',
    ] as const)
        assert.ok(left.has(toHex(h[name])), name)
    assert.equal(meta(world, 'epoch'), epoch + 1)
    assert.equal(meta(world, 'deletionsPending'), false)
    assert.deepEqual(meta(world, 'lastGcAt'), {
        day: DAYS,
        time: (meta(world, 'lastGcAt') as { time: number }).time,
    })
    assert.ok(!requested.has('userAssets'), 'GC never reads userAssets')
    assert.equal(rows(world, 'userAssets').size, 1)
    // Run today already and nothing pending: not due.
    assert.deepEqual(await deleter.gc(false), { kind: 'skipped' })
    // A pass that sweeps nothing bumps nothing.
    assert.deepEqual(await deleter.gc(), { kind: 'done', swept: 0 })
    assert.equal(meta(world, 'epoch'), epoch + 1)
})

test('GC removes nothing while a newer build’s data is in use, and sweeps a newer body nothing reaches', async () => {
    const cases: [
        string,
        (h: Awaited<ReturnType<typeof seedBodies>>) => Parameters<typeof tamper>[1],
    ][] = [
        ['a newer database format', () => (tx) => writeMeta(tx, 'formatVersion', 2)],
        [
            'a session of a newer version',
            () => (tx) =>
                tx
                    .put('sessions', { id: 'n', chainId: 'c', v: SESSION_V + 1 })
                    .then(() => undefined),
        ],
        [
            'an entry of an unknown kind',
            () => (tx) =>
                tx.put('entries', { sessionId: 's', seq: 2, kind: 'future' }).then(() => undefined),
        ],
        [
            'a root of a newer version',
            (h) => async (tx) => {
                const row = (await tx.get('nodes', hashKey(h.root))) as Record<string, unknown>
                await tx.put('nodes', { ...row, v: RECORDS_V + 1 }, hashKey(h.root))
            },
        ],
        [
            'a node of an unknown type',
            (h) => async (tx) => {
                const row = (await tx.get('nodes', hashKey(h.node))) as Record<string, unknown>
                await tx.put('nodes', { ...row, t: 'tree' }, hashKey(h.node))
            },
        ],
    ]
    for (const [why, change] of cases) {
        const { world, deleter } = await fresh(2)
        const h = await seedBodies(world)
        await tamper(world, change(h))
        const before = bodies(world)
        assert.deepEqual(await deleter.gc(), { kind: 'unsafe', why }, why)
        assert.deepEqual(bodies(world), before, why)
    }
    // Unreachable, the same newer root is an ordinary body.
    const { world, deleter } = await fresh(3)
    const h = await seedBodies(world)
    await tamper(world, async (tx) => {
        const row = (await tx.get('nodes', hashKey(h.orphanNode))) as Record<string, unknown>
        await tx.put('nodes', { ...row, t: 'root', v: RECORDS_V + 1 }, hashKey(h.orphanNode))
    })
    assert.deepEqual(await deleter.gc(), { kind: 'done', swept: 4 })
})

test('a Deleted chain holding newer data is swept with its bodies; while it is there GC is unsafe', async () => {
    const world = createWorld({ seed: 4 })
    const storage = new MemoryStorage()
    const { first, second } = await closedChain(world, storage)
    world.checks.transitions = false
    await tamper(world, async (tx) => {
        const head = (await tx.get('sessions', second.id)) as Record<string, unknown>
        await tx.put('sessions', { ...head, v: SESSION_V + 1 })
    })
    world.checks.transitions = true
    await daysPass(world)
    const deleter = await openDeleter(world, world.tab('b'), storage)
    assert.equal((await deleter.gc())?.kind, 'unsafe')
    assert.ok(bodies(world).size > 0)
    assert.equal((await deleter.mark(first.chainId)).kind, 'marked')
    assert.deepEqual(await deleter.sweep(), { removed: 1, busy: false })
    // The runner's GC follows the sweep and removes every body: nothing else was stored.
    assert.equal((await deleter.gc())?.kind, 'done')
    assert.deepEqual(bodies(world), new Set())
    assert.deepEqual(await deleter.gc(), { kind: 'done', swept: 0 })
})

test('a flush that reuses a hash GC swept stores it again (the closure check)', async () => {
    const world = createWorld({ seed: 5 })
    const storage = new MemoryStorage()
    const page = await openPage(world, world.tab('a'))
    const a = stateOf(goldenChart())
    const old = page.flusher.begin({
        id: testId(),
        docId: testId(),
        origin: 'import',
        state: a,
        operation: originOperation('import'),
        dirty: false,
    })
    await page.flusher.flush({ strict: true })
    // The tab goes on in another chart; the old chain is closed and Deleted elsewhere.
    page.flusher.begin({
        id: testId(),
        docId: testId(),
        origin: 'import',
        state: sampleState('tests/fixtures/generated-large.json'),
        operation: originOperation('import'),
        dirty: false,
    })
    await page.flusher.flush({ strict: true })
    await daysPass(world)
    const deleter = await openDeleter(world, world.tab('b'), storage)
    assert.equal((await deleter.mark(old.chainId)).kind, 'marked')
    assert.deepEqual(await deleter.sweep(), { removed: 1, busy: false })
    assert.equal((await deleter.gc())?.kind, 'done')
    const { encodeSnapshot } = await import('../../../src/local/records/snapshot')
    const { toRecords } = await import('../../../src/local/records/records')
    const root = encodeSnapshot(toRecords(a)).root.hash
    assert.ok(!bodies(world).has(toHex(root)), 'GC swept the old chart')
    // The page still knows those chunks as stored at the old epoch: an edit back to the old chart.
    page.flusher.append({ kind: 'edit', step: editStep(futureFixtureOperation('Pasted')) }, a, true)
    await page.flusher.flush({ strict: true })
    await page.flusher.flush({ strict: true })
    assert.deepEqual(checkStored(world.memory), [])
    assert.ok(storedRecords(world, root))
})

test('GC is busy while a writer holds nse-maint, and stops for a waiting writer with its sweeps kept', async () => {
    const { world, deleter } = await fresh(6)
    await tamper(world, async (tx) => {
        await writeMeta(tx, 'daysOfUse', DAYS)
        for (let n = 0; n < 600; n++)
            await tx.put(
                'chunks',
                { bytes: new Uint8Array([1]), size: 1, crc32: 0, day: 1 },
                hashKey(hash()),
            )
    })
    const writer = world.tab('writer')
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    void writer.run(() => writer.locks.request(MAINT_LOCK, { mode: 'shared' }, () => held))
    await world.idle()
    assert.deepEqual(await deleter.gc(), { kind: 'busy' })
    release()
    await world.idle()

    // A writer asks after the first sweep batch: the pass stops there, that batch committed.
    // (Three looks come before it, one ahead of each body store's key read.)
    const epoch = meta(world, 'epoch') as number
    assert.deepEqual(
        await deleter.tab.run(() => gcPass(waitingAfter(deleter, 4), { always: true })),
        {
            kind: 'aborted',
            swept: 500,
        },
    )
    assert.equal(meta(world, 'epoch'), epoch + 1)
    assert.equal(rows(world, 'chunks').size, 100)
    // The next pass marks again and sweeps the rest.
    assert.deepEqual(await deleter.gc(), { kind: 'done', swept: 100 })
})

test('a writer’s request for nse-maint is seen as waiting by a deleting job', async () => {
    const world = createWorld({ seed: 7 })
    const tab = world.tab('gc')
    const core = workerCore(world, tab)
    await tab.run(() => core.start())
    const writer = world.tab('writer')
    const seen = await tab.run(() =>
        core.exclusive(async (hold) => {
            const before = await hold.writerWaiting()
            void writer.run(() =>
                writer.locks.request(MAINT_LOCK, { mode: 'shared' }, () => Promise.resolve()),
            )
            for (let n = 0; n < 20 && !(await hold.writerWaiting()); n++)
                await hold.read(['meta'], () => Promise.resolve())
            return [before, await hold.writerWaiting()]
        }),
    )
    assert.deepEqual(seen, { ran: true, value: [false, true] })
    await world.idle()
})

test('with storing paused for a full browser, a removal and GC still run and leave the pause', async () => {
    const world = createWorld({ seed: 8 })
    const storage = new MemoryStorage()
    const { first, second } = await closedChain(world, storage)
    await daysPass(world)
    const deleter = await openDeleter(world, world.tab('b'), storage, {
        core: { flags: { forceQuota: true } },
    })
    await deleter.tab
        .run(() => deleter.core.write(['meta'], (tx) => writeMeta(tx, 'epoch', 0)))
        .catch(() => undefined)
    assert.deepEqual(deleter.core.status, { mode: 'stored', reason: 'full' })
    const request = {
        chainId: first.chainId,
        locked: [first.id, second.id],
        expect: {
            head: second.id,
            updatedAt: rows(world, 'chains').get(first.chainId)?.updatedAt as number,
        },
        reason: 'deleteSessions' as const,
    }
    // A removal that fails reports its own failure, and the pause stays as it was.
    world.memory.faults.request = (stores, mode) =>
        mode === 'readwrite' && stores.includes('chains')
            ? new DOMException('Disk', 'UnknownError')
            : undefined
    assert.deepEqual(await deleter.remove(request), { kind: 'failed' })
    world.memory.faults.request = undefined
    assert.deepEqual(deleter.core.status, { mode: 'stored', reason: 'full' })
    assert.deepEqual(await deleter.remove(request), { kind: 'removed', sessions: 2 })
    assert.equal((await deleter.gc())?.kind, 'done')
    assert.deepEqual(bodies(world), new Set())
    assert.deepEqual(deleter.core.status, { mode: 'stored', reason: 'full' })
})

test('GC is busy only while an import runs: a pending import no tab runs never holds it up', async () => {
    const { world, deleter } = await fresh(9)
    const h = await seedBodies(world)
    // An import that deduped against an old orphan body: its parent node is a later batch.
    await tamper(world, (tx) =>
        tx
            .put('sessions', { id: 'p', chainId: 'c', v: SESSION_V, importPending: true })
            .then(() => undefined),
    )
    const before = bodies(world)
    const importer = world.tab('importer')
    let release!: () => void
    const running = new Promise<void>((resolve) => (release = resolve))
    void importer.run(() => importer.locks.request(importLock('p'), {}, () => running))
    await world.idle()
    assert.deepEqual(await deleter.gc(), { kind: 'busy' })
    assert.deepEqual(bodies(world), before)
    assert.ok(bodies(world).has(toHex(h.orphanNode)))
    // The import stopped (a full browser, a closed tab): still pending, its lock gone. A resumed
    // run starts again at batch 0 and stores again whatever was swept.
    release()
    await world.idle()
    assert.deepEqual(await deleter.gc(), { kind: 'done', swept: 4 })
})

test('GC counts a lock query that fails as a running import', async () => {
    const world = createWorld({ seed: 12, checks: false })
    const tab = world.tab('gc')
    const deleter = await openDeleter(world, tab, new MemoryStorage(), {
        core: { locks: { ...tab.locks, query: () => Promise.reject(new Error('No query')) } },
    })
    await seedBodies(world)
    const before = bodies(world)
    assert.deepEqual(await deleter.gc(), { kind: 'busy' })
    assert.deepEqual(bodies(world), before)
})

test('a pass that finds newer data is not repeated before the next day of use, and leaves the deletion pending', async () => {
    const { world, deleter } = await fresh(10)
    await seedBodies(world)
    await tamper(world, async (tx) => {
        await tx.put('entries', { sessionId: 's', seq: 2, kind: 'future' })
        await writeMeta(tx, 'deletionsPending', true)
    })
    assert.deepEqual(await deleter.gc(false), {
        kind: 'unsafe',
        why: 'an entry of an unknown kind',
    })
    assert.equal(meta(world, 'deletionsPending'), true)
    assert.equal((meta(world, 'lastGcAt') as { day: number }).day, DAYS)
    assert.deepEqual(await deleter.gc(false), { kind: 'skipped' })
    // The next day of use tries again.
    await daysPass(world, 1)
    assert.equal((await deleter.gc(false))?.kind, 'unsafe')
})

test('a writer who waits during the key reads ends the pass before anything is swept', async () => {
    const { world, deleter } = await fresh(11)
    await seedBodies(world)
    const before = bodies(world)
    assert.deepEqual(
        await deleter.tab.run(() => gcPass(waitingAfter(deleter, 1), { always: true })),
        {
            kind: 'aborted',
            swept: 0,
        },
    )
    assert.deepEqual(bodies(world), before)
})
