import assert from 'node:assert/strict'
import test from 'node:test'
import { toHex } from '../../../src/local/hash'
import { MemoryStorage } from '../../../src/local/journal/store'
import type { KvTx } from '../../../src/local/kv/types'
import { holdSessionLock } from '../../../src/local/sessions'
import { restoreAsCopy, setSessionContext } from '../../../src/local/startup/api'
import { journalsStep, type RecoveryContext } from '../../../src/local/startup/steps'
import { claimSessionLock } from '../../../src/local/startup/tab'
import { checkStored } from '../../../src/local/testing/invariants'
import { createWorld, type World } from '../../../src/local/testing/world'
import { editStep, futureFixtureOperation } from '../../helpers/historySteps'
import { openPage, rows, workerCore } from '../flush/harness'
import { append, beginSession, openJournalPage, type JournalPage } from '../journal/harness'
import { goldenChart, stateOf } from '../records/charts'
import { sessionRow, widen } from '../timeline/helpers'
import { beginIn, continueIn, readOpen } from './harness'
import { load, openSession, recordTab, type TabStorage } from './load'

// Guards each with a test of its own (Step 4 re-review R7): what a load, a rebuild and a replay
// would get wrong without each one alone.

const tamper = async (world: World, change: (tx: KvTx) => Promise<void>) => {
    const tab = world.tab(`tamper-${String(Math.random())}`)
    const core = workerCore(world, tab)
    await tab.run(() => core.start())
    await tab.run(() => core.write(['sessions', 'chains', 'entries', 'stackBlocks'], change))
}

const dropStack = (world: World, sessionId: string) =>
    tamper(world, async (tx) => {
        const session = (await tx.get('sessions', sessionId)) as Record<string, unknown>
        const rest = { ...session }
        Reflect.deleteProperty(rest, 'stack')
        await tx.put('sessions', rest)
    })

const quiet = async <T>(fn: () => Promise<T>) => {
    const errors = console.error
    console.error = () => undefined
    try {
        return await fn()
    } finally {
        console.error = errors
    }
}

const withoutWebLocks = async (fn: () => Promise<void>) => {
    const navigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true })
    try {
        await fn()
    } finally {
        if (navigator) Object.defineProperty(globalThis, 'navigator', navigator)
    }
}

test('a fork’s missing stack is rebuilt over its parent as it was forked, not as the parent went on', async () => {
    const world = createWorld({ seed: 1 })
    const page = await openPage(world, world.tab('a'))
    const a = stateOf(goldenChart())
    const parent = beginIn(page, a)
    page.flusher.append(
        { kind: 'edit', step: editStep(futureFixtureOperation('Edit')) },
        widen(a),
        true,
    )
    await page.flusher.flush()
    const other = await openPage(world, world.tab('b'))
    const fork = continueIn(other, await readOpen(other, parent.id), { asFork: true })
    other.flusher.append(
        { kind: 'edit', step: editStep(futureFixtureOperation('Fork edit')) },
        widen(a, 2),
        true,
    )
    await other.flusher.flush()
    const before = await readOpen(other, fork.id)
    // The parent goes on in its own tab.
    page.flusher.append(
        { kind: 'edit', step: editStep(futureFixtureOperation('Later')) },
        widen(a, 3),
        true,
    )
    page.flusher.append(
        { kind: 'edit', step: editStep(futureFixtureOperation('Later still')) },
        widen(a, 4),
        true,
    )
    await page.flusher.flush()
    await dropStack(world, fork.id)
    const rebuilt = await readOpen(other, fork.id)
    assert.deepEqual(rebuilt.stack.window, before.stack.window)
    assert.deepEqual(
        rebuilt.stack.slots.map((slot) => toHex(slot.snapshot)),
        before.stack.slots.map((slot) => toHex(slot.snapshot)),
    )
})

test('a rebuilt window never starts below the stored parent’s own window', async () => {
    const world = createWorld({ seed: 2 })
    const page = await openPage(world, world.tab('a'))
    const a = stateOf(goldenChart())
    const b = widen(a)
    const parent = beginIn(page, a)
    for (let i = 1; i < 6_000; i++)
        page.flusher.append(
            { kind: 'edit', step: editStep(futureFixtureOperation(`Edit ${i}`)) },
            i % 2 ? b : a,
            true,
        )
    await page.flusher.flush()
    const read = await readOpen(page, parent.id)
    const continuation = continueIn(page, read)
    // Ten undos, then an edit: the stack ends below the parent's window's top.
    for (let i = 1; i <= 10; i++)
        page.flusher.append(
            { kind: 'undo', step: editStep(futureFixtureOperation(`Edit ${6000 - i}`)) },
            (5999 - i) % 2 ? b : a,
            true,
        )
    page.flusher.append(
        { kind: 'edit', step: editStep(futureFixtureOperation('Edit')) },
        widen(a, 2),
        true,
    )
    await page.flusher.flush()
    await dropStack(world, continuation.id)
    const rebuilt = await readOpen(page, continuation.id)
    assert.equal(rebuilt.stack.window.base, read.stack.window.base)
    assert.ok(rebuilt.stack.slots.every((slot) => slot !== undefined))
})

test('a continuation’s journal over a parent window of two blocks keeps every slot', async () => {
    const world = createWorld({ seed: 3 })
    const storage = new MemoryStorage()
    const first = await openJournalPage(world, 'first', storage)
    let s = stateOf(goldenChart())
    const parent = beginSession(first, s)
    for (let i = 0; i < 300; i++) {
        s = widen(s, i)
        append(first, { kind: 'edit', step: editStep(futureFixtureOperation(`E${i}`)) }, s)
    }
    await first.flusher.flush({ strict: true })
    const parentRead = await readOpen(first, parent.id)
    first.tab.kill()
    const visit = await load(world, 'visit', storage)
    const continuation = openSession(visit)
    append(visit.page, { kind: 'edit', step: editStep(futureFixtureOperation('X')) }, widen(s, 7))
    assert.equal(visit.page.writer.write(), true)
    visit.page.tab.kill()

    const reload = await load(world, 'reload', storage, { tab: visit.tab })
    const read = await readOpen(reload.page, continuation.id)
    assert.equal(read.stack.slots.length, 302)
    for (let i = 0; i < 301; i++)
        assert.equal(
            toHex(read.stack.slots[i]!.snapshot),
            toHex(parentRead.stack.slots[i]!.snapshot),
        )
    // It starts after its parent's last entry.
    const row = sessionRow(world, continuation.id)!
    const parentRow = sessionRow(world, parent.id)!
    assert.ok((row.startedAt as number) > (parentRow.updatedAt as number))
    assert.deepEqual(checkStored(world.memory), [])
})

test('a continuation’s journal whose parent took its own journal first is kept as a recovery chain', async () => {
    const world = createWorld({ seed: 4 })
    const storage = new MemoryStorage()
    // The parent's tab dies with edits only its journal holds.
    const first = await openJournalPage(world, 'first', storage)
    const a = stateOf(goldenChart())
    const parent = beginSession(first, a)
    append(first, { kind: 'edit', step: editStep(futureFixtureOperation('E1')) }, widen(a))
    await first.flusher.flush({ strict: true })
    append(
        first,
        { kind: 'edit', step: editStep(futureFixtureOperation('Only journalled')) },
        widen(a, 2),
    )
    assert.equal(first.writer.write(), true)
    first.tab.kill()
    // Another tab continued it from the stored state (before any replay), and died unstored.
    const second = await openJournalPage(world, 'second', storage)
    const continuation = continueIn(second, await readOpen(second, parent.id))
    second.live.state = widen(a)
    append(
        second,
        { kind: 'edit', step: editStep(futureFixtureOperation('In the continuation')) },
        widen(a, 5),
    )
    assert.equal(second.writer.write(), true)
    second.tab.kill()

    const next = await load(world, 'next', storage)
    const kinds = Object.fromEntries(
        next.recovery.outcomes.map((outcome) => [outcome.sessionId, outcome.kind]),
    )
    assert.deepEqual(kinds, { [parent.id]: 'applied', [continuation.id]: 'recovery' })
    assert.equal(rows(world, 'sessions').has(continuation.id), false)
    assert.deepEqual(checkStored(world.memory), [])
})

test('a reload over its own failed journal holds the session’s lock until its continuation stores', async () => {
    const world = createWorld({ seed: 5 })
    const storage = new MemoryStorage()
    const tab: TabStorage = new Map()
    const first = await openJournalPage(world, 'first', storage)
    const a = stateOf(goldenChart())
    const session = beginSession(first, a)
    recordTab(tab, { sessionId: session.id, start: 'stored' })
    await first.flusher.flush({ strict: true })
    append(
        first,
        { kind: 'edit', step: editStep(futureFixtureOperation('Only journalled')) },
        widen(a, 2),
    )
    assert.equal(first.writer.write(), true)
    first.tab.kill()
    await quiet(() =>
        load(world, 'reload', storage, {
            tab,
            worker: { applyJournal: () => Promise.reject(new Error('QuotaExceededError')) },
        }),
    )
    // Another tab's load can't take the session (or replay its journal) meanwhile.
    const other = world.tab('other')
    assert.equal(await other.run(() => claimSessionLock(other.locks, session.id)), undefined)
})

test('a reload’s own journal it can’t load goes to Local Data', async () => {
    const world = createWorld({ seed: 6 })
    const storage = new MemoryStorage()
    const tab: TabStorage = new Map()
    const unavailable = { flags: { noStorage: true } }
    const first = await openJournalPage(world, 'first', storage, {}, unavailable)
    const a = stateOf(goldenChart())
    const session = beginSession(first, a, 'new')
    append(first, { kind: 'edit', step: editStep(futureFixtureOperation('Edit')) }, widen(a))
    assert.equal(first.writer.write(), true)
    first.tab.kill()
    const key = `nse.journal.${session.id}`
    storage.setItem(
        key,
        JSON.stringify({ ...JSON.parse(storage.getItem(key)!), journalVersion: 3 }),
    )
    recordTab(tab, { sessionId: session.id, start: 'new' })
    const reload = await load(world, 'reload', storage, { tab, core: unavailable })
    assert.equal(reload.claim.kind, 'reload')
    assert.equal(reload.opened, false)
    assert.deepEqual(
        reload.recovery.keptForLocalData.map((found) => found.sessionId),
        [session.id],
    )
    assert.ok(reload.events.some((event) => event.kind === 'unsavedInLocalData'))
})

test('without Web Locks, every other journal is offered even where the page’s lock service says held', async () => {
    const world = createWorld({ seed: 7 })
    const storage = new MemoryStorage()
    const unavailable = { flags: { noStorage: true } }
    const first = await openJournalPage(world, 'first', storage, {}, unavailable)
    const a = stateOf(goldenChart())
    const session = beginSession(first, a, 'new')
    append(first, { kind: 'edit', step: editStep(futureFixtureOperation('Edit')) }, widen(a))
    assert.equal(first.writer.write(), true)
    const held = holdSessionLock(first.tab.locks, session.id)
    await first.tab.run(() => held.granted)
    await withoutWebLocks(async () => {
        const later = await load(world, 'later', storage, { core: unavailable })
        assert.deepEqual(
            later.recovery.keptForLocalData.map((found) => found.sessionId),
            [session.id],
        )
    })
    held.release()
})

test('with Web Locks, a journal whose lock request fails is offered all the same', async () => {
    const world = createWorld({ seed: 8 })
    const storage = new MemoryStorage()
    const unavailable = { flags: { noStorage: true } }
    const first = await openJournalPage(world, 'first', storage, {}, unavailable)
    const a = stateOf(goldenChart())
    beginSession(first, a, 'new')
    append(first, { kind: 'edit', step: editStep(futureFixtureOperation('Edit')) }, widen(a))
    assert.equal(first.writer.write(), true)
    const later = await load(world, 'later', storage, { core: unavailable })
    const context: RecoveryContext = {
        ...later.recovery,
        locks: {
            request: () => Promise.reject(new Error('Refused')),
            query: () => Promise.resolve({ held: [], pending: [] }),
        },
        keptForLocalData: [],
        events: () => undefined,
    }
    await journalsStep(context)
    // A row only copies or downloads: offering it is the safe side (re-review RR5).
    assert.equal(context.keptForLocalData.length, 1)
})

test('Restore as a Copy without Web Locks never asks which tab holds the session', async () => {
    const world = createWorld({ seed: 9 })
    const storage = new MemoryStorage()
    const other = await openJournalPage(world, 'other', storage)
    const a = stateOf(goldenChart())
    const lock = holdSessionLock(other.tab.locks, 'held')
    await other.tab.run(() => lock.granted)
    const session = beginSession(other, a, 'import', { id: 'held' })
    await other.flusher.flush({ strict: true })
    const loaded = await load(world, 'tab', storage)
    await withoutWebLocks(async () => {
        setSessionContext(
            {
                ...loaded.deps,
                client: {
                    id: () => Promise.resolve(undefined),
                    heldElsewhere: () => Promise.reject(new Error('No Web Locks')),
                },
            },
            loaded.recovery,
        )
        assert.equal(await loaded.page.tab.run(() => restoreAsCopy(session.id)), true)
    })
    assert.notEqual(openSession(loaded).forkOf, undefined)
    lock.release()
})

test('startup never opens over a chart made while the head loads, nor reads on over one made before', async () => {
    const world = createWorld({ seed: 10 })
    const storage = new MemoryStorage()
    const first = await openJournalPage(world, 'first', storage)
    const a = stateOf(goldenChart())
    const stored = beginSession(first, a)
    await first.flusher.flush({ strict: true })
    first.tab.kill()
    // An edit lands while the head's records are read.
    const loading: { page?: JournalPage } = {}
    const visit = await load(world, 'visit', storage, {
        meanwhile: (page) => {
            loading.page = page
        },
        call: (method, result) => {
            if (method === 'readSnapshot' && loading.page) {
                append(
                    loading.page,
                    { kind: 'edit', step: editStep(futureFixtureOperation('Typed meanwhile')) },
                    widen(a, 7),
                )
                loading.page = undefined
            }
            return result
        },
    })
    assert.equal(visit.opened, false)
    assert.equal(openSession(visit), visit.blank)
    assert.equal(rows(world, 'chains').get(stored.chainId)?.head, stored.id)
    visit.page.tab.kill()
    // One made before the open: the most recent session isn't even read.
    const called: string[] = []
    const later = await load(world, 'later', storage, {
        meanwhile: (page) => {
            append(
                page,
                { kind: 'edit', step: editStep(futureFixtureOperation('Typed before')) },
                widen(a, 8),
            )
        },
        call: (method, result) => {
            called.push(method)
            return result
        },
    })
    assert.equal(later.opened, false)
    assert.deepEqual(called, [])
})
