import assert from 'node:assert/strict'
import test from 'node:test'
import { toHex } from '../../../src/local/hash'
import { journalState } from '../../../src/local/journal/content'
import { readJournal } from '../../../src/local/journal/format'
import { MemoryStorage } from '../../../src/local/journal/store'
import { webLockService } from '../../../src/local/locks'
import { toRecords } from '../../../src/local/records/records'
import { encodeSnapshot } from '../../../src/local/records/snapshot'
import { holdSessionLock } from '../../../src/local/sessions'
import { claimTab } from '../../../src/local/startup/open'
import { journalsStep, type RecoveryContext } from '../../../src/local/startup/steps'
import { MARKER_WAIT_MS } from '../../../src/local/startup/tab'
import { checkStored } from '../../../src/local/testing/invariants'
import { createWorld, type World } from '../../../src/local/testing/world'
import type { State } from '../../../src/state'
import { rows } from '../flush/harness'
import { append, beginSession, openJournalPage, type JournalPage } from '../journal/harness'
import { goldenChart, stateOf } from '../records/charts'
import { storedEntries, widen } from '../timeline/helpers'
import { autoSaveText } from './autoSaveText'
import { readOpen } from './harness'
import { load, markUnloaded, openSession, recordTab, type TabStorage } from './load'

// Which session a load opens (Part 1 §1.4.2), on the test core: the claim, the recovery order and
// `openAtStart` run as `start.ts` runs them. A reload never appends to a session over its own
// journal that wasn't applied (§1.6.4 step 2), and an unstored continuation's journal is applied
// as its first write.

const rootOf = (state: State) => toHex(encodeSnapshot(toRecords(state)).root.hash)

const journalText = (storage: MemoryStorage, sessionId: string) =>
    storage.getItem(`nse.journal.${sessionId}`)

const journalRoot = (text: string, sessionId: string) => {
    const reading = readJournal(text, sessionId)
    assert.equal(reading.kind, 'journal')
    if (reading.kind !== 'journal') return ''
    const content = journalState(reading.journal)
    assert.equal(content.kind, 'state')
    return content.kind === 'state' ? rootOf(content.state) : ''
}

/**
 * A tab with a stored session S (one flushed edit) and three edits only its journal holds, as
 * when storing paused for quota; then the tab dies.
 */
const journalledOnly = async (world: World, storage: MemoryStorage) => {
    const tab: TabStorage = new Map()
    const page = await openJournalPage(world, 'first', storage)
    const a = stateOf(goldenChart())
    const session = beginSession(page, a)
    recordTab(tab, { sessionId: session.id, start: 'stored' })
    append(page, 'edit', 'E0', widen(a))
    await page.flusher.flush({ strict: true })
    const last = widen(a, 3)
    append(page, 'edit', 'E1', widen(a, 1))
    append(page, 'edit', 'E2', widen(a, 2))
    append(page, 'edit', 'E3', last)
    assert.equal(page.writer.write(), true)
    page.tab.kill()
    // What the journal holds, as its level data reads back.
    const root = journalRoot(journalText(storage, session.id) ?? '', session.id)
    return { tab, session, a, last, root }
}

const quiet = async <T>(fn: () => Promise<T>) => {
    const errors = console.error
    console.error = () => undefined
    try {
        return await fn()
    } finally {
        console.error = errors
    }
}

test('a reload whose own journal fails to apply continues its session in a new one, and the journal is kept, never covered', async () => {
    const world = createWorld({ seed: 1 })
    const storage = new MemoryStorage()
    const { tab, session, last, root } = await journalledOnly(world, storage)
    const text = journalText(storage, session.id)
    assert.ok(text)

    // The reload: its own replay fails (the disk still full, a timeout).
    const reload = await quiet(() =>
        load(world, 'reload', storage, {
            tab,
            worker: { applyJournal: () => Promise.reject(new Error('QuotaExceededError')) },
        }),
    )
    assert.equal(reload.claim.kind, 'reload')
    assert.equal(reload.recovery.ownOutcome?.kind, 'failed')
    assert.equal(reload.opened, true)
    const continued = openSession(reload)
    assert.notEqual(continued.id, session.id)
    assert.equal(continued.parent?.id, session.id)
    assert.ok(reload.events.some((event) => event.kind === 'journalFailed'))

    // Its edits and hides write its own key; S's journal stays as it was.
    append(reload.page, 'edit', 'X1', widen(last, 9))
    assert.equal(reload.page.writer.write(), true)
    assert.equal(journalText(storage, session.id), text)
    await reload.page.flusher.flush({ strict: true })
    assert.equal(rows(world, 'chains').get(session.chainId)?.head, continued.id)
    reload.page.tab.kill()

    // The next load keeps S's journal as a recovery chain holding its last edits.
    const next = await load(world, 'next', storage)
    const outcome = next.recovery.outcomes.find((each) => each.sessionId === session.id)
    assert.ok(outcome && 'result' in outcome && outcome.result.kind === 'recovery')
    const recovered = await readOpen(next.page, outcome.result.sessionId)
    assert.equal(toHex(recovered.head), root)
    assert.equal(journalText(storage, session.id), null)
    assert.deepEqual(checkStored(world.memory), [])
})

test('a reload whose own journal a newer build wrote continues its session in a new one', async () => {
    const world = createWorld({ seed: 2 })
    const storage = new MemoryStorage()
    const { tab, session } = await journalledOnly(world, storage)
    const key = `nse.journal.${session.id}`
    const newer = JSON.stringify({ ...JSON.parse(storage.getItem(key)!), journalVersion: 2 })
    storage.setItem(key, newer)

    const reload = await load(world, 'reload', storage, { tab })
    assert.equal(reload.recovery.ownOutcome?.kind, 'later')
    assert.equal(reload.recovery.ownLeft, true)
    assert.equal(openSession(reload).parent?.id, session.id)
    assert.ok(reload.events.some((event) => event.kind === 'journalLater'))
    // Never appended to: its `seq`s stay the journal's, and the key stays.
    assert.equal(rows(world, 'sessions').get(session.id)?.lastSeq, 2)
    assert.equal(storage.getItem(key), newer)
})

test('a reload whose own journal applied takes its session up again', async () => {
    const world = createWorld({ seed: 3 })
    const storage = new MemoryStorage()
    const { tab, session, root } = await journalledOnly(world, storage)
    const reload = await load(world, 'reload', storage, { tab })
    assert.equal(reload.recovery.ownOutcome?.kind, 'applied')
    assert.equal(openSession(reload).id, session.id)
    assert.equal(rootOf(reload.page.live.state), root)
    // Its own reload says nothing (§1.4.3); the golden chart's BGM isn't held here.
    assert.deepEqual(reload.events, [{ kind: 'bgmNotLoaded' }])
    assert.deepEqual(checkStored(world.memory), [])
})

test('a reload whose own journal was kept as a recovery session continues that one, with its edits', async () => {
    const world = createWorld({ seed: 4 })
    const storage = new MemoryStorage()
    const { tab, session, last, root } = await journalledOnly(world, storage)
    // Another tab continued S during the gap, so S's journal can't be applied to S.
    const other = await openJournalPage(world, 'other', storage)
    const read = await readOpen(other, session.id)
    other.flusher.continueSession({
        id: 'continued-elsewhere',
        chainId: session.chainId,
        docId: session.docId,
        lineageId: String(read.chain.lineageId),
        parent: { id: session.id, uptoSeq: read.session.lastSeq as number },
        stack: {
            first: read.stack.window.base,
            slots: read.stack.slots.map(({ snapshot, label }) => ({ hash: snapshot, label })),
            index: read.stack.window.index,
        },
        chain: read.chain,
        label: () => 'Continued',
        dirty: false,
    })
    other.live.state = widen(last, 20)
    append(other, 'edit', 'Elsewhere', widen(last, 20))
    await other.flusher.flush({ strict: true })
    other.tab.kill()

    const reload = await load(world, 'reload', storage, { tab })
    const outcome = reload.recovery.ownOutcome
    assert.ok(outcome && 'result' in outcome && outcome.result.kind === 'recovery')
    assert.equal(openSession(reload).parent?.id, outcome.result.sessionId)
    assert.equal(rootOf(reload.page.live.state), root)
    assert.ok(reload.events.some((event) => event.kind === 'journalKept'))
})

test('an unstored continuation killed before its first flush: its journal is applied to it, and its reload takes it up', async () => {
    const world = createWorld({ seed: 5 })
    const storage = new MemoryStorage()
    const first = await openJournalPage(world, 'first', storage)
    const a = stateOf(goldenChart())
    const parent = beginSession(first, a)
    append(first, 'edit', 'E1', widen(a))
    await first.flusher.flush({ strict: true })
    first.tab.kill()

    // A new visit continues it, edits, and is killed before the first flush commits.
    const visit = await load(world, 'visit', storage)
    const continuation = openSession(visit)
    assert.equal(continuation.parent?.id, parent.id)
    append(visit.page, 'edit', 'E2', widen(a, 3))
    assert.equal(visit.page.writer.write(), true)
    const edited = journalRoot(journalText(storage, continuation.id) ?? '', continuation.id)
    visit.page.tab.kill()
    assert.equal(rows(world, 'sessions').has(continuation.id), false)

    // Its reload: the journal is the continuation's first write, and the reload takes it up.
    const reload = await load(world, 'reload', storage, { tab: visit.tab })
    assert.equal(reload.claim.kind, 'reload')
    const outcome = reload.recovery.ownOutcome
    assert.ok(outcome && 'result' in outcome)
    assert.deepEqual(outcome.result, { kind: 'applied', created: true })
    assert.equal(rows(world, 'chains').get(parent.chainId)?.head, continuation.id)
    assert.equal(rows(world, 'chains').size, 1)
    assert.equal(openSession(reload).id, continuation.id)
    assert.equal(rootOf(reload.page.live.state), edited)
    // Its stack keeps the parent's slots, copied into its own blocks.
    const read = await readOpen(reload.page, continuation.id)
    assert.equal(read.stack.slots.length, 3)
    assert.equal(read.stack.blocks.length, 1)
    assert.deepEqual(
        storedEntries(world, continuation.id).map((entry) => entry.kind),
        ['recovered'],
    )
    assert.deepEqual(checkStored(world.memory), [])
})

test('an unstored continuation’s journal whose chain moved on is kept as a recovery chain', async () => {
    const world = createWorld({ seed: 6 })
    const storage = new MemoryStorage()
    const first = await openJournalPage(world, 'first', storage)
    const a = stateOf(goldenChart())
    const parent = beginSession(first, a)
    await first.flusher.flush({ strict: true })
    first.tab.kill()
    const visit = await load(world, 'visit', storage)
    const continuation = openSession(visit)
    append(visit.page, 'edit', 'E2', widen(a, 3))
    assert.equal(visit.page.writer.write(), true)
    visit.page.tab.kill()
    // Another visit continues the chain meanwhile, while the journal's session reads as live.
    const holder = world.tab('holder')
    const held = holdSessionLock(holder.locks, continuation.id)
    await holder.run(() => held.granted)
    const back = await load(world, 'back', storage)
    assert.equal(openSession(back).parent?.id, parent.id)
    append(back.page, 'edit', 'Later', widen(a, 5))
    await back.page.flusher.flush({ strict: true })
    back.page.tab.kill()
    held.release()

    const next = await load(world, 'next', storage)
    assert.deepEqual(
        next.recovery.outcomes.map((outcome) => outcome.kind),
        ['recovery'],
    )
    assert.equal(rows(world, 'chains').get(parent.chainId)?.head, openSession(back).id)
    assert.equal(rows(world, 'sessions').has(continuation.id), false)
    assert.deepEqual(checkStored(world.memory), [])
})

test('the journal store never replaces or clears a key it neither wrote nor loaded', async () => {
    const world = createWorld({ seed: 7 })
    const storage = new MemoryStorage()
    const { session } = await journalledOnly(world, storage)
    const text = journalText(storage, session.id)
    assert.ok(text)
    const page = await openJournalPage(world, 'reload', storage)
    assert.equal(page.store.writeWhole({ sessionId: session.id, seq: 9 }), false)
    page.store.clear(session.id, 100)
    assert.equal(journalText(storage, session.id), text)
    // Loaded, it's the page's to write.
    const [found] = await page.store.read()
    assert.ok(found)
    page.store.adopt(found)
    assert.equal(page.store.writeWhole({ sessionId: session.id, seq: 9 }), true)
})

test('a page without Web Locks: the claim is a reload only with the marker, and earlier journals are offered, never an error', async () => {
    const world = createWorld({ seed: 8 })
    const navigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true })
    try {
        const storage = new MemoryStorage()
        const tab: TabStorage = new Map()
        const earlier = await openJournalPage(
            world,
            'earlier',
            storage,
            {},
            {
                flags: { noStorage: true },
            },
        )
        const a = stateOf(goldenChart())
        const session = beginSession(earlier, a, 'new')
        append(earlier, 'edit', 'Edit', widen(a))
        assert.equal(earlier.writer.write(), true)
        earlier.tab.kill()
        recordTab(tab, { sessionId: session.id, start: 'new' })

        // A copied tab (or a crash): no marker, so its journal goes to Local Data, unshared.
        const copy = await load(world, 'copy', storage, {
            tab: new Map(tab),
            core: { flags: { noStorage: true } },
        })
        assert.equal(copy.claim.kind, 'duplicate')
        assert.equal(copy.opened, false)
        assert.deepEqual(
            copy.recovery.keptForLocalData.map((found) => found.sessionId),
            [session.id],
        )
        assert.deepEqual(
            copy.events.map((event) => event.kind),
            ['unsavedInLocalData'],
        )
        // The page's own lock service has none to ask: the step offers the journal all the same.
        const recovery: RecoveryContext = {
            ...copy.recovery,
            locks: webLockService,
            keptForLocalData: [],
            events: () => undefined,
        }
        await journalsStep(recovery)
        assert.equal(recovery.keptForLocalData.length, 1)

        // Its own reload, after the page went away, continues from it.
        markUnloaded(tab, session.id)
        const reload = await load(world, 'reload', storage, {
            tab,
            core: { flags: { noStorage: true } },
        })
        assert.equal(reload.claim.kind, 'reload')
        assert.equal(reload.opened, true)
        assert.equal(openSession(reload).id, session.id)
        append(reload.page, 'edit', 'Again', widen(a, 2))
        assert.equal(reload.page.writer.write(), true)
    } finally {
        if (navigator) Object.defineProperty(globalThis, 'navigator', navigator)
    }
})

test('the claim: a held lock released within the marker’s wait is a reload; held past it, a Duplicate Tab', async () => {
    const world = createWorld({ seed: 9 })
    const tab: TabStorage = new Map()
    recordTab(tab, { sessionId: 'S', start: 'stored' })
    markUnloaded(tab, 'S')
    const holder = world.tab('unloading')
    const claimer = world.tab('reloading')
    const claimIn = (storage: TabStorage) => {
        sessionStorage.clear()
        for (const [key, value] of storage) sessionStorage.setItem(key, value)
        return claimer.run(() => claimTab(claimer.locks))
    }

    // The unloading page's late flush ends within the wait.
    const late = holdSessionLock(holder.locks, 'S')
    await holder.run(() => late.granted)
    const claiming = claimIn(tab)
    setTimeout(() => {
        late.release()
    }, 200)
    const claim = await claiming
    assert.equal(claim.kind, 'reload')
    if (claim.kind === 'reload') claim.lock.release()

    // A live tab keeps it past the wait: a Duplicate Tab.
    const live = holdSessionLock(holder.locks, 'S')
    await holder.run(() => live.granted)
    const started = Date.now()
    assert.equal((await claimIn(tab)).kind, 'duplicate')
    assert.ok(Date.now() - started >= MARKER_WAIT_MS - 50)
    // Without the marker it asks once, at once.
    tab.delete([...tab.keys()].find((key) => key.endsWith('unloaded'))!)
    assert.equal((await claimIn(tab)).kind, 'duplicate')
    live.release()
    sessionStorage.clear()
    assert.equal((await claimTab(claimer.locks)).kind, 'none')
})

test('a load never opens a stored session over a chart made meanwhile', async () => {
    const world = createWorld({ seed: 10 })
    const storage = new MemoryStorage()
    const first = await openJournalPage(world, 'first', storage)
    const a = stateOf(goldenChart())
    const stored = beginSession(first, a)
    await first.flusher.flush({ strict: true })
    first.tab.kill()
    const visit = await load(world, 'visit', storage, {
        meanwhile: (page: JournalPage) => {
            append(page, 'edit', 'Typed meanwhile', widen(a, 7))
        },
    })
    assert.equal(visit.opened, false)
    assert.equal(openSession(visit), visit.blank)
    assert.equal(rows(world, 'chains').get(stored.chainId)?.head, stored.id)
})

test('the migrated auto save’s line says whether it’s the session that opened', async () => {
    const world = createWorld({ seed: 11 })
    const storage = new MemoryStorage()
    // A reload of another stored session opens that one; the migrated session is kept.
    const { tab, session } = await journalledOnly(world, storage)
    storage.removeItem(`nse.journal.${session.id}`)
    storage.setItem('nse.autoSave.levelData', autoSaveText(widen(stateOf(goldenChart()), 4)))
    const reload = await load(world, 'reload', storage, { tab })
    const migrated = reload.events.find((event) => event.kind === 'migrated')
    assert.ok(migrated?.kind === 'migrated')
    assert.equal(migrated.opened, false)
    assert.equal(openSession(reload).id, session.id)
    reload.page.tab.kill()

    // A new visit continues the migrated session, the newest: its line says so.
    storage.setItem('nse.autoSave.levelData', autoSaveText(widen(stateOf(goldenChart()), 6)))
    const visit = await load(world, 'visit', storage)
    const line = visit.events.find((event) => event.kind === 'migrated')
    assert.ok(line?.kind === 'migrated')
    assert.equal(line.opened, true)
    assert.equal(openSession(visit).parent?.id, line.sessionId)
    assert.equal(
        visit.events.some((event) => event.kind === 'continued'),
        false,
    )
})
