import assert from 'node:assert/strict'
import test from 'node:test'
import { DB_NAME, DB_VERSION, writeMeta } from '../../../src/local/db'
import type { FlushResult } from '../../../src/local/flushWrite'
import { keyText } from '../../../src/local/kv/keys'
import { MemoryKv } from '../../../src/local/kv/memory'
import type { Key, KvFactory, TxMode } from '../../../src/local/kv/types'
import { checkStored } from '../../../src/local/testing/invariants'
import { crashSweep } from '../../../src/local/testing/sweep'
import { CI_SEEDS, createWorld, type World } from '../../../src/local/testing/world'
import type { StorageStatus } from '../../../src/local/worker/core'
import { flushHandlers } from '../../../src/local/worker/flushHandlers'
import type { State } from '../../../src/state'
import { replaceNote } from '../../../src/state/mutations/slides/note'
import { createTransaction } from '../../../src/state/transaction'
import { editStep, nativeOperation, originOperation } from '../../helpers/historySteps'
import { goldenChart, stateOf } from '../records/charts'
import {
    openPage,
    openSplitPage,
    storeRows,
    testId,
    workerCore,
    type Page,
    type SplitPage,
} from './harness'

// The page and its storage worker as separate actors (§1.6.5): a worker killed alone, a restart
// in memory mode, Try Again's move racing a flush, and a reopen that finds a newer database. The
// timers run on the world's clock, so each seed replays them in order.

/** The state with its n-th note one quarter wider. */
const widenedNoteStep = editStep(
    nativeOperation(
        { id: 'nse.object.edit', data: { subject: 'note', changed: { note: 1 } } },
        'Changed note',
    ),
)

const widenedNoteEntry = { kind: 'edit' as const, step: widenedNoteStep }

const widen = (state: State, n = 0) => {
    const notes = [...state.store.slides.note.values()].flat()

    const target = notes[n % notes.length]!
    const transaction = createTransaction(state)
    replaceNote(transaction, target, { ...target, size: target.size + 0.25 })
    return transaction.commit([])
}

const begin = (page: SplitPage, state: State, origin: 'new' | 'import' = 'import') =>
    page.flusher.begin({
        id: testId(),
        docId: testId(),
        origin,
        state,
        operation: originOperation(origin),
        dirty: false,
    })

const edit = (page: SplitPage, state: State) => {
    page.flusher.append(widenedNoteEntry, state, true)
}

/** Every row of every store, as text, to tell whether anything was written. */
const snapshotOf = (memory: MemoryKv) =>
    JSON.stringify(
        [...memory.dump(DB_NAME)].map(([store, list]) => [
            store,
            list.map((row) => [keyText(row.key as Key), JSON.stringify(row.value, replacer)]),
        ]),
    )

const replacer = (_: string, value: unknown) =>
    value instanceof Uint8Array ? keyText(value) : value

/** Each session's entry seqs in a store, and its `lastSeq`. */
const sessionsIn = (memory: MemoryKv) => {
    const entries = [...storeRows(memory, 'entries').values()]
    return [...storeRows(memory, 'sessions').values()].map((session) => ({
        lastSeq: session.lastSeq,
        entryCount: session.entryCount,
        seqs: entries
            .filter((entry) => entry.sessionId === session.id)
            .map((entry) => entry.seq as number),
    }))
}

const settle = async (world: World) => {
    await world.clock.run()
    await world.idle()
}

test('a current worker that reopens into a newer database writes nothing and is read-only', async () => {
    for (const seed of CI_SEEDS) {
        const world = createWorld({ seed })
        const page = await openSplitPage(world, { name: 'old' })
        let state = stateOf(goldenChart())
        begin(page, state)
        await page.flusher.flush()
        assert.deepEqual(page.host.core.status, { mode: 'stored' })

        // The tab is backgrounded: its connection is lost, and it misses the newer tab's broadcast.
        world.memory.loseConnections(DB_NAME)
        await world.idle()
        const next = world.tab('next')
        const nextCore = workerCore(world, next, {
            flags: { dbVersion: DB_VERSION + 1 },
            channel: next.channel('nobody'),
        })
        await next.run(() => nextCore.start())
        assert.equal(world.memory.version(DB_NAME), DB_VERSION + 1)
        const before = snapshotOf(world.memory)

        state = widen(state)
        edit(page, state)
        await page.flusher.flush()
        await world.idle()
        assert.equal(snapshotOf(world.memory), before, `seed ${seed}`)
        assert.deepEqual(page.host.core.status, { mode: 'readOnly' }, `seed ${seed}`)
        assert.equal(page.flusher.hasPending, true)
    }
})

test('Try Again’s move racing a flush loses no entry and leaves no dangling ref', async () => {
    for (const seed of CI_SEEDS) {
        const world = createWorld({ seed })
        const frozen = world.tab('frozen')
        const frozenCore = workerCore(world, frozen, { flags: { ignoreVersionChange: true } })
        await frozen.run(() => frozenCore.start())

        // A newer tab behind the frozen current tab runs in memory.
        const opening = openSplitPage(world, { flags: { dbVersion: DB_VERSION + 1 } })
        await world.clock.run()
        const page = await opening
        assert.deepEqual(page.status, { mode: 'memory', reason: 'olderTabs' })
        let state = stateOf(goldenChart())
        begin(page, state)
        await page.flusher.flush()
        state = widen(state)
        edit(page, state)
        await page.flusher.flush()

        // The frozen tab goes; Try Again moves the in-memory rows while an edit is flushed.
        frozen.kill()
        await world.idle()
        const trying = page.host.call((_, core) => core.tryAgain())
        state = widen(state, 1)
        edit(page, state)
        const flushing = page.flusher.flush()
        await settle(world)
        assert.deepEqual(await trying, { mode: 'stored' }, `seed ${seed}`)
        await flushing

        // Later edits go on from there.
        state = widen(state, 2)
        edit(page, state)
        await page.flusher.flush()
        await settle(world)
        assert.deepEqual(page.errors, [], `seed ${seed}`)
        assert.deepEqual(
            sessionsIn(world.memory),
            [{ lastSeq: 4, entryCount: 4, seqs: [1, 2, 3, 4] }],
            `seed ${seed}`,
        )
        assert.deepEqual(checkStored(world.memory), [], `seed ${seed}`)
    }
})

test('rows Try Again moves in take the database’s day of use, not the memory store’s', async () => {
    const world = createWorld({ seed: 5 })
    // A long-used database: 40 days of use, the last long ago.
    const setup = world.tab('setup')
    const setupCore = workerCore(world, setup)
    await setup.run(() => setupCore.start())
    await setup.run(() =>
        setupCore.write(['meta'], async (tx) => {
            await writeMeta(tx, 'daysOfUse', 40)
            await writeMeta(tx, 'lastUseDate', '2000-01-01')
        }),
    )
    const frozen = world.tab('frozen')
    const frozenCore = workerCore(world, frozen, { flags: { ignoreVersionChange: true } })
    await frozen.run(() => frozenCore.start())
    const opening = openSplitPage(world, { flags: { dbVersion: DB_VERSION + 1 } })
    await world.clock.run()
    const page = await opening
    let state = stateOf(goldenChart())
    begin(page, state)
    state = widen(state)
    edit(page, state)
    await page.flusher.flush()
    assert.deepEqual(
        [...storeRows(page.host.memory, 'entries').values()].map((entry) => entry.day),
        [1, 1],
    )
    frozen.kill()
    await world.idle()
    const trying = page.host.call((_, core) => core.tryAgain())
    await settle(world)
    assert.deepEqual(await trying, { mode: 'stored' })
    const today = storeRows(world.memory, 'meta').get('daysOfUse')?.value
    assert.equal(today, 41)
    for (const store of ['entries', 'sessions', 'chains', 'nodes', 'chunks'])
        for (const row of storeRows(world.memory, store).values())
            assert.equal(row.day, today, store)
})

test('a batch planned before a memory-mode worker restart is planned again for the new store', async () => {
    for (const seed of CI_SEEDS) {
        const world = createWorld({ seed })
        const page = await openSplitPage(world, { flags: { noStorage: true } })
        let state = stateOf(goldenChart())
        begin(page, state)
        await page.flusher.flush()

        // The worker dies; the next flush plans its batch with the old memo while it restarts.
        state = widen(state)
        edit(page, state)
        page.host.worker.kill()
        const flushing = page.flusher.flush()
        await settle(world)
        await flushing
        assert.equal(page.host.starts, 2)
        assert.equal(page.flusher.hasPending, false)
        assert.deepEqual(checkStored(page.host.memory), [], `seed ${seed}`)
        assert.deepEqual(
            sessionsIn(page.host.memory),
            [{ lastSeq: 2, entryCount: 2, seqs: [1, 2] }],
            `seed ${seed}`,
        )
    }
})

test('a memo learned on another store is checked again, whatever the epoch', async () => {
    const world = createWorld({ seed: 6 })
    const tab = world.tab('a')
    const first = new MemoryKv(world.scheduler)
    const ref: { handlers?: Page['handlers'] } = {}
    const results: FlushResult[] = []
    const page = await openPage(
        world,
        tab,
        {
            transport: async (batch) => {
                const result = await tab.run(() => ref.handlers!.flush(batch))
                results.push(result)
                return result
            },
        },
        { flags: { noStorage: true }, memory: () => first.factory(tab.actor) },
    )
    ref.handlers = page.handlers
    let state = stateOf(goldenChart())
    page.flusher.begin({
        id: testId(),
        docId: testId(),
        origin: 'import',
        state,
        operation: originOperation('import'),
        dirty: false,
    })
    await page.flusher.flush()
    // Another store at the same epoch, 0, behind the page's back.
    const second = new MemoryKv(world.scheduler)
    const core = workerCore(world, tab, {
        flags: { noStorage: true },
        memory: () => second.factory(tab.actor),
    })
    await tab.run(() => core.start())
    ref.handlers = flushHandlers({ core, test: true, emit: () => undefined }, tab.waiter)
    state = widen(state)
    page.flusher.append(widenedNoteEntry, state, true)
    await page.flusher.flush()
    assert.deepEqual(page.errors, [])
    assert.deepEqual(
        results.map((result) => result.kind),
        ['stored', 'missing', 'stored'],
    )
    assert.deepEqual(checkStored(second), [])
})

test('a worker restart in memory mode keeps the history the old worker acknowledged', async () => {
    const world = createWorld({ seed: 4 })
    const page = await openSplitPage(world, { flags: { noStorage: true } })
    let state = stateOf(goldenChart())
    begin(page, state)
    await page.flusher.flush()
    for (let i = 0; i < 3; i++) {
        state = widen(state, i)
        edit(page, state)
        await page.flusher.flush()
    }
    assert.equal(page.flusher.hasPending, false)
    page.host.worker.kill()
    await settle(world)
    assert.equal(page.host.starts, 2)
    assert.deepEqual(sessionsIn(page.host.memory), [
        { lastSeq: 4, entryCount: 4, seqs: [1, 2, 3, 4] },
    ])
    assert.deepEqual(checkStored(page.host.memory), [])
})

for (const [name, flags] of [
    ['stored', {}],
    ['in memory', { noStorage: true }],
] as const)
    test(`the worker alone killed at every await of two flushes (${name}): every entry stored once`, async () => {
        const base = stateOf(goldenChart())
        const edited = widen(base)
        const again = widen(edited, 3)
        const pages = new Map<World, SplitPage>()
        const result = await crashSweep({
            seeds: [undefined, ...CI_SEEDS.slice(0, 2)],
            scenario: async ({ world, victim }) => {
                const page = await openSplitPage(world, { flags, first: victim })
                pages.set(world, page)
                begin(page, base, 'new')
                edit(page, edited)
                await page.flusher.flush()
                edit(page, again)
                await page.flusher.flush()
            },
            recover: async ({ world }) => {
                await settle(world)
            },
            check: ({ world, killedAt }) => {
                const page = pages.get(world)
                assert.ok(page)
                const store = name === 'stored' ? world.memory : page.host.memory
                assert.deepEqual(checkStored(store), [], `killed at ${String(killedAt)}`)
                assert.equal(page.flusher.hasPending, false)
                assert.deepEqual(
                    sessionsIn(store),
                    [{ lastSeq: 3, entryCount: 3, seqs: [1, 2, 3] }],
                    `killed at ${String(killedAt)}`,
                )
                // The killed worker’s nse-maint went with it.
                assert.equal(
                    world.locks.snapshot().held.some((lock) => lock.name === 'nse-maint'),
                    false,
                )
            },
        })
        assert.ok(result.every(({ points }) => points > 10))
    })

/** A factory whose databases call `onTx` as each transaction begins. */
const watchTransactions = (
    factory: KvFactory,
    onTx: (stores: readonly string[], mode: TxMode) => void,
): KvFactory => ({
    open: async (name, version, options) => {
        const db = await factory.open(name, version, options)
        const transaction = db.transaction.bind(db)
        db.transaction = (stores, mode, fn, txOptions) => {
            onTx(stores, mode)
            return transaction(stores, mode, fn, txOptions)
        }
        return db
    },
})

for (const when of ['before', 'during'] as const)
    test(`a newer tab asking ${when} Try Again’s copy is answered, and storing steps aside`, async () => {
        for (const seed of CI_SEEDS) {
            const world = createWorld({ seed })
            const frozen = world.tab('frozen')
            const frozenCore = workerCore(world, frozen, { flags: { ignoreVersionChange: true } })
            await frozen.run(() => frozenCore.start())

            // A newer tab behind the frozen current tab, in memory, with a row to move.
            const tab = world.tab('next')
            const newest = world.tab('newest')
            const newestCore = workerCore(world, newest, { flags: { dbVersion: DB_VERSION + 2 } })
            let armed = false
            let newer: Promise<StorageStatus> | undefined
            const ask = (moment: typeof when) => {
                if (!armed || moment !== when) return
                armed = false
                newer = newest.run(() => newestCore.start())
            }
            const memory = new MemoryKv(world.scheduler)
            const core = workerCore(world, tab, {
                flags: { dbVersion: DB_VERSION + 1 },
                // The copy reads the memory store whole, then writes the database in one go.
                memory: () =>
                    watchTransactions(memory.factory(tab.actor), (stores, mode) => {
                        if (mode === 'readonly' && stores.length > 1) ask('before')
                    }),
                factory: watchTransactions(tab.kv, (stores, mode) => {
                    if (mode === 'readwrite' && stores.length > 1) ask('during')
                }),
            })
            const opening = tab.run(() => core.start())
            await world.idle()
            assert.deepEqual(await opening, { mode: 'memory', reason: 'olderTabs' })
            await tab.run(() =>
                core.write(['recovered'], (tx) =>
                    tx.put('recovered', { id: 'kept', source: 'test' }),
                ),
            )
            frozen.kill()
            await world.idle()
            armed = true
            await tab.run(() => core.tryAgain()).catch(() => undefined)
            await world.idle()
            assert.ok(newer, `seed ${seed}`)
            // The newer tab opened its version, never held back by the move's connection.
            assert.deepEqual(await newer, { mode: 'stored' }, `seed ${seed}`)
            assert.equal(world.memory.version(DB_NAME), DB_VERSION + 2, `seed ${seed}`)
            assert.notDeepEqual(core.status, { mode: 'stored' }, `seed ${seed}`)
            if (when === 'during')
                assert.deepEqual(core.status, { mode: 'stored', reason: 'upgrading' })
            await world.idle()
        }
    })

test('a write held behind Try Again’s move counts the move’s steps as its progress', async () => {
    const world = createWorld({ seed: 3 })
    const frozen = world.tab('frozen')
    const frozenCore = workerCore(world, frozen, { flags: { ignoreVersionChange: true } })
    await frozen.run(() => frozenCore.start())
    const tab = world.tab('next')
    let held: Promise<unknown> | undefined
    let heldTicks = 0
    const core = workerCore(world, tab, {
        flags: { dbVersion: DB_VERSION + 1 },
        factory: watchTransactions(tab.kv, (stores, mode) => {
            if (held || mode !== 'readwrite' || stores.length === 1) return
            // A flush arriving while the move copies: it waits at the gate.
            held = core.write(['meta'], (tx) => tx.put('meta', { key: 'late', value: 1 }), {
                tick: () => heldTicks++,
            })
        }),
    })
    const opening = tab.run(() => core.start())
    await world.idle()
    await opening
    for (let i = 0; i < 10; i++)
        await tab.run(() =>
            core.write(['recovered'], (tx) => tx.put('recovered', { id: `r${i}`, source: 'test' })),
        )
    frozen.kill()
    await world.idle()
    let ownTicks = 0
    assert.deepEqual(await tab.run(() => core.tryAgain({ tick: () => ownTicks++ })), {
        mode: 'stored',
    })
    await held
    // Its own two steps, and one for each row the move copied while it waited.
    assert.ok(ownTicks >= 10, `${ownTicks}`)
    assert.ok(heldTicks >= 10, `${heldTicks}`)
})

test('a batch planned before a restart is planned again even where the new store has the same id', async () => {
    for (const seed of CI_SEEDS) {
        const world = createWorld({ seed })
        // Every in-memory store gets the same dbInstanceId: the memo's mark can't tell them apart.
        const page = await openSplitPage(world, {
            flags: { noStorage: true },
            core: { randomId: () => 'same' },
        })
        let state = stateOf(goldenChart())
        begin(page, state)
        await page.flusher.flush()
        state = widen(state)
        edit(page, state)
        page.host.worker.kill()
        const flushing = page.flusher.flush()
        await settle(world)
        await flushing
        assert.equal(page.host.starts, 2)
        assert.equal(page.flusher.hasPending, false)
        assert.deepEqual(checkStored(page.host.memory), [], `seed ${seed}`)
        assert.deepEqual(
            sessionsIn(page.host.memory),
            [{ lastSeq: 2, entryCount: 2, seqs: [1, 2] }],
            `seed ${seed}`,
        )
    }
})

test('where no database will ever answer, a replaced session’s in-memory history is let go', async () => {
    const world = createWorld({ seed: 8 })
    const page = await openSplitPage(world, { flags: { noStorage: true } })
    const released: string[] = []
    const start = (id: string, state: State) =>
        page.flusher.begin({
            id,
            docId: testId(),
            origin: 'import',
            state,
            operation: originOperation('import'),
            dirty: false,
            done: () => released.push(id),
        })
    const state = stateOf(goldenChart())
    start('first', state)
    await page.flusher.flush()
    start('second', widen(state))
    await page.flusher.flush()
    // The first session's lock went with it; the current one's history is still kept.
    assert.deepEqual(released, ['first'])
    page.host.worker.kill()
    await settle(world)
    assert.deepEqual(
        sessionsIn(page.host.memory).map(({ seqs }) => seqs),
        [[1]],
    )
})
