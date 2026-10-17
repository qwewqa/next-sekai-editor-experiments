import assert from 'node:assert/strict'
import test from 'node:test'
import { DB_NAME } from '../../../src/local/db'
import type { FlushResult } from '../../../src/local/flushWrite'
import { keyText } from '../../../src/local/kv/keys'
import { MemoryKv } from '../../../src/local/kv/memory'
import type { Key } from '../../../src/local/kv/types'
import { checkStored } from '../../../src/local/testing/invariants'
import { crashSweep } from '../../../src/local/testing/sweep'
import { CI_SEEDS, createWorld, type World } from '../../../src/local/testing/world'
import { flushHandlers } from '../../../src/local/worker/flushHandlers'
import type { State } from '../../../src/state'
import { replaceNote } from '../../../src/state/mutations/slides/note'
import { createTransaction } from '../../../src/state/transaction'
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
        label: () => 'Initialize',
        dirty: false,
    })

const edit = (page: SplitPage, state: State) => {
    page.flusher.append('edit', () => 'Changed note', state, true)
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

test('a v1 worker that reopens into a newer database writes nothing and is read-only', async () => {
    for (const seed of CI_SEEDS) {
        const world = createWorld({ seed })
        const page = await openSplitPage(world, { name: 'old' })
        let state = stateOf(goldenChart())
        begin(page, state)
        await page.flusher.flush()
        assert.deepEqual(page.host.core.status, { mode: 'stored' })

        // The tab is backgrounded: its connection is lost, and it misses the v2 tab's broadcast.
        world.memory.loseConnections(DB_NAME)
        await world.idle()
        const next = world.tab('next')
        const nextCore = workerCore(world, next, {
            flags: { dbVersion: 2 },
            channel: next.channel('nobody'),
        })
        await next.run(() => nextCore.start())
        assert.equal(world.memory.version(DB_NAME), 2)
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

        // A v2 tab behind the frozen v1 tab runs in memory.
        const opening = openSplitPage(world, { flags: { dbVersion: 2 } })
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
        label: () => 'Initialize',
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
    page.flusher.append('edit', () => 'Changed note', state, true)
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
