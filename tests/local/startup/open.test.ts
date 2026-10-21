import assert from 'node:assert/strict'
import test from 'node:test'
import { toHex } from '../../../src/local/hash'
import { journalState } from '../../../src/local/journal/content'
import { readJournal } from '../../../src/local/journal/format'
import { MemoryStorage } from '../../../src/local/journal/store'
import type { KvTx } from '../../../src/local/kv/types'
import { webLockService } from '../../../src/local/locks'
import { sessionCopyOf } from '../../../src/local/names'
import { toRecords } from '../../../src/local/records/records'
import { encodeSnapshot } from '../../../src/local/records/snapshot'
import { holdSessionLock } from '../../../src/local/sessions'
import { boundElsewhere, claimTab } from '../../../src/local/startup/open'
import { journalsStep, type RecoveryContext } from '../../../src/local/startup/steps'
import { claimSessionLock, MARKER_WAIT_MS } from '../../../src/local/startup/tab'
import { checkStored } from '../../../src/local/testing/invariants'
import { createWorld, type World } from '../../../src/local/testing/world'
import type { State } from '../../../src/state'
import { editStep, futureFixtureOperation, nativeOperation } from '../../helpers/historySteps'
import '../../helpers/lockChecks'
import { rows, workerCore } from '../flush/harness'
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
    append(page, { kind: 'edit', step: editStep(futureFixtureOperation('E0')) }, widen(a))
    await page.flusher.flush({ strict: true })
    const last = widen(a, 3)
    append(page, { kind: 'edit', step: editStep(futureFixtureOperation('E1')) }, widen(a, 1))
    append(page, { kind: 'edit', step: editStep(futureFixtureOperation('E2')) }, widen(a, 2))
    append(page, { kind: 'edit', step: editStep(futureFixtureOperation('E3')) }, last)
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

/** A reload whose own journal's apply fails (the disk still full, a timeout). */
const failedReload = (world: World, storage: MemoryStorage, tab: TabStorage) =>
    quiet(() =>
        load(world, 'reload', storage, {
            tab,
            worker: { applyJournal: () => Promise.reject(new Error('QuotaExceededError')) },
        }),
    )

test('a reload whose own journal fails to apply continues its session from the journal’s state, and says it recovered it', async () => {
    const world = createWorld({ seed: 1 })
    const storage = new MemoryStorage()
    const { tab, session, root } = await journalledOnly(world, storage)
    assert.ok(journalText(storage, session.id))

    const reload = await failedReload(world, storage, tab)
    assert.equal(reload.claim.kind, 'reload')
    assert.equal(reload.recovery.ownOutcome?.kind, 'failed')
    assert.equal(reload.opened, true)
    const continued = openSession(reload)
    assert.notEqual(continued.id, session.id)
    assert.equal(continued.parent?.id, session.id)
    // The newest work is on screen, so Local Data doesn't offer the key, and the line says so.
    assert.equal(rootOf(reload.page.live.state), root)
    assert.equal(
        (reload.shown.at(-1)?.slots.at(-1)?.step.operation as { fallback: { text: string } })
            .fallback.text,
        'Recovered last change',
    )
    assert.deepEqual(reload.recovery.keptForLocalData, [])
    assert.deepEqual(
        reload.events.filter((event) => event.kind !== 'bgmNotLoaded').map((event) => event.kind),
        ['journalRecovered'],
    )

    // The continuation's own journal holds the work: S's key goes, and its flush stores it.
    assert.equal(reload.page.writer.write(), true)
    assert.equal(journalText(storage, session.id), null)
    await reload.page.flusher.flush({ strict: true })
    assert.equal(rows(world, 'chains').get(session.chainId)?.head, continued.id)
    assert.equal(toHex((await readOpen(reload.page, continued.id)).head), root)
    reload.page.tab.kill()

    // Nothing is left for the next load to recover, so no second copy.
    const next = await load(world, 'next', storage)
    assert.deepEqual(next.recovery.outcomes, [])
    assert.deepEqual(checkStored(world.memory), [])
})

test('a failed own journal’s key goes once the continuation’s strict commit holds its work', async () => {
    const world = createWorld({ seed: 17 })
    const storage = new MemoryStorage()
    const { tab, session, root } = await journalledOnly(world, storage)
    const reload = await failedReload(world, storage, tab)
    await reload.page.flusher.flush({ strict: true })
    assert.equal(journalText(storage, session.id), null)
    assert.equal(toHex((await readOpen(reload.page, openSession(reload).id)).head), root)
})

test('a reload whose own journal a newer build wrote continues its session in a new one', async () => {
    const world = createWorld({ seed: 2 })
    const storage = new MemoryStorage()
    const { tab, session } = await journalledOnly(world, storage)
    const key = `nse.journal.${session.id}`
    const newer = JSON.stringify({ ...JSON.parse(storage.getItem(key)!), journalVersion: 3 })
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
            slots: read.stack.slots.map(({ snapshot, step }) => ({ hash: snapshot, step })),
            index: read.stack.window.index,
        },
        chain: read.chain,
        operation: nativeOperation(
            { id: 'nse.continue', data: { fromTime: read.session.updatedAt as number } },
            'Continued',
        ),
        dirty: false,
    })
    other.live.state = widen(last, 20)
    append(
        other,
        { kind: 'edit', step: editStep(futureFixtureOperation('Elsewhere')) },
        widen(last, 20),
    )
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
    append(first, { kind: 'edit', step: editStep(futureFixtureOperation('E1')) }, widen(a))
    await first.flusher.flush({ strict: true })
    first.tab.kill()

    // A new visit continues it, edits, and is killed before the first flush commits.
    const visit = await load(world, 'visit', storage)
    const continuation = openSession(visit)
    assert.equal(continuation.parent?.id, parent.id)
    append(visit.page, { kind: 'edit', step: editStep(futureFixtureOperation('E2')) }, widen(a, 3))
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
    append(visit.page, { kind: 'edit', step: editStep(futureFixtureOperation('E2')) }, widen(a, 3))
    assert.equal(visit.page.writer.write(), true)
    visit.page.tab.kill()
    // Another visit continues the chain meanwhile, while the journal's session reads as live.
    const holder = world.tab('holder')
    const held = holdSessionLock(holder.locks, continuation.id)
    await holder.run(() => held.granted)
    const back = await load(world, 'back', storage)
    assert.equal(openSession(back).parent?.id, parent.id)
    append(
        back.page,
        { kind: 'edit', step: editStep(futureFixtureOperation('Later')) },
        widen(a, 5),
    )
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
        append(earlier, { kind: 'edit', step: editStep(futureFixtureOperation('Edit')) }, widen(a))
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

        // With the marker it continues from it, under a session id of its own: a copied tab
        // looks the same, and two tabs never share one key (§1.6.7). The old key stays, offered
        // in Local Data: the tab it came from may still be writing it.
        markUnloaded(tab, session.id)
        const reload = await load(world, 'reload', storage, {
            tab,
            core: { flags: { noStorage: true } },
        })
        assert.equal(reload.claim.kind, 'reload')
        assert.equal(reload.opened, true)
        const resumed = openSession(reload)
        assert.notEqual(resumed.id, session.id)
        assert.equal(resumed.chainId, session.chainId)
        append(
            reload.page,
            { kind: 'edit', step: editStep(futureFixtureOperation('Again')) },
            widen(a, 2),
        )
        assert.equal(reload.page.writer.write(), true)
        assert.ok(storage.getItem(`nse.journal.${session.id}`))
        assert.ok(storage.getItem(`nse.journal.${resumed.id}`))
        assert.deepEqual(
            reload.recovery.keptForLocalData.map((found) => found.sessionId),
            [session.id],
        )
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
            append(
                page,
                { kind: 'edit', step: editStep(futureFixtureOperation('Typed meanwhile')) },
                widen(a, 7),
            )
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

const tamper = async (world: World, change: (tx: KvTx) => Promise<void>) => {
    const tab = world.tab(`tamper-${String(Math.random())}`)
    const core = workerCore(world, tab)
    await tab.run(() => core.start())
    await tab.run(() =>
        core.write(
            ['sessions', 'chains', 'entries', 'tombstones', 'stackBlocks', 'handles'],
            change,
        ),
    )
}

test('a session this build can’t open is never passed over silently: a reload’s own, and a new visit’s newest', async () => {
    const world = createWorld({ seed: 12 })
    const storage = new MemoryStorage()
    const first = await openJournalPage(world, 'first', storage)
    const a = stateOf(goldenChart())
    const older = beginSession(first, a)
    await first.flusher.flush({ strict: true })
    const newer = beginSession(first, widen(a))
    await first.flusher.flush({ strict: true })
    first.tab.kill()
    const tab: TabStorage = new Map()
    recordTab(tab, { sessionId: newer.id, start: 'stored' })
    await tamper(world, async (tx) => {
        const row = (await tx.get('sessions', newer.id)) as Record<string, unknown>
        await tx.put('sessions', { ...row, v: 3 })
    })

    const reload = await load(world, 'reload', storage, { tab })
    assert.equal(reload.opened, false)
    assert.deepEqual(reload.events, [{ kind: 'notOpened', which: 'reload', why: 'later' }])
    reload.page.tab.kill()

    const visit = await load(world, 'visit', storage)
    assert.equal(openSession(visit).parent?.id, older.id)
    assert.deepEqual(visit.events[0], { kind: 'notOpened', which: 'newest', why: 'later' })
})

test('a newer database outside safe mode: a reload continues from its own journal, as with storage unavailable', async () => {
    const world = createWorld({ seed: 13 })
    const storage = new MemoryStorage()
    const readOnly = { flags: { readOnly: true } }
    const visit = await load(world, 'visit', storage, { core: readOnly })
    assert.equal(visit.page.core.status.mode, 'readOnly')
    const a = stateOf(goldenChart())
    const session = beginSession(visit.page, a, 'new')
    append(visit.page, { kind: 'edit', step: editStep(futureFixtureOperation('Edit')) }, widen(a))
    assert.equal(visit.page.writer.write(), true)
    visit.page.tab.kill()
    recordTab(visit.tab, { sessionId: session.id, start: 'new' })

    const reload = await load(world, 'reload', storage, { tab: visit.tab, core: readOnly })
    assert.equal(reload.opened, true)
    assert.equal(openSession(reload).id, session.id)
    // A copy of the tab finds it in Local Data.
    const copy = await load(world, 'copy', storage, { core: readOnly })
    assert.equal(copy.recovery.keptForLocalData.length, 0)
})

/** The newest chain is bound to coconut.nxsp, and another tab has another chain open on it. */
const boundElsewhereSetup = async (seed: number) => {
    const world = createWorld({ seed })
    const storage = new MemoryStorage()
    const first = await openJournalPage(world, 'first', storage)
    const a = stateOf(goldenChart())
    const bound = beginSession(first, a)
    await first.flusher.flush({ strict: true })
    first.tab.kill()
    // Another tab has a different chain open, bound to the same file.
    const other = await openJournalPage(world, 'other', storage)
    const lock = holdSessionLock(other.tab.locks, 'other-session')
    await other.tab.run(() => lock.granted)
    beginSession(other, widen(a, 2), 'import', { id: 'other-session' })
    await other.flusher.flush({ strict: true })
    // The newest chain is the bound one again; both have a stored handle (D24).
    await tamper(world, async (tx) => {
        for (const chainId of [bound.chainId, other.flusher.session!.chainId]) {
            const chain = (await tx.get('chains', chainId)) as Record<string, unknown>
            await tx.put('chains', {
                ...chain,
                file: { name: 'coconut.nxsp' },
                ...(chainId === bound.chainId ? { updatedAt: 9_999_999_999_999 } : {}),
            })
            await tx.put('handles', {
                chainId,
                role: 'file',
                name: 'coconut.nxsp',
                handle: { testFile: 'coconut' },
            })
        }
    })
    return { world, storage, bound, lock }
}

test('a new visit whose most recent session’s file is bound in another tab’s open session forks it', async () => {
    const { world, storage, bound, lock } = await boundElsewhereSetup(14)
    // The store holds plain values: the reads carry fake handles, one file for both.
    let failBindings = false
    let failComparison = false
    let missingHandle = false
    let handleReads = 0
    const file = {
        isSameEntry: (other: unknown) =>
            failComparison
                ? Promise.reject(new Error('comparison failed'))
                : Promise.resolve(other === file),
    }
    const visit = await load(world, 'visit', storage, {
        call: (method, result) => {
            if (method === 'readBindings' && failBindings) throw new Error('bindings unavailable')
            if (method !== 'readHandle') return result
            handleReads++
            return missingHandle ? undefined : result ? file : result
        },
    })
    const copy = openSession(visit)
    assert.notEqual(copy.forkOf, undefined)
    assert.equal(copy.parent?.id, bound.id)
    assert.deepEqual(
        visit.events.find((event) => event.kind === 'separateCopy'),
        {
            kind: 'separateCopy',
            of: { name: 'coconut.nxsp', bound: true },
        },
    )
    const target = await readOpen(visit.page, bound.id)
    failBindings = true
    const beforeFailure = handleReads
    // A failed read, a throw, or a handle that can't be compared is unknown, never "no".
    assert.equal(await visit.page.tab.run(() => boundElsewhere(visit.deps, target)), 'unknown')
    assert.equal(handleReads, beforeFailure, 'failed enumeration must not eagerly read handles')
    failBindings = false
    failComparison = true
    assert.equal(await visit.page.tab.run(() => boundElsewhere(visit.deps, target)), 'unknown')
    failComparison = false
    assert.equal(await visit.page.tab.run(() => boundElsewhere(visit.deps, target)), 'yes')
    missingHandle = true
    assert.equal(await visit.page.tab.run(() => boundElsewhere(visit.deps, target)), 'no')
    failBindings = true
    assert.equal(
        await visit.page.tab.run(() =>
            boundElsewhere(visit.deps, { ...target, chain: { ...target.chain, file: undefined } }),
        ),
        'no',
    )
    lock.release()
})

for (const [name, fails] of [
    ['the bindings read fails', 'readBindings'],
    ['a handle read fails', 'readHandle'],
] as const)
    test(`a new visit whose binding check cannot be answered (${name}) forks and says "may"`, async () => {
        const { world, storage, lock } = await boundElsewhereSetup(14)
        const file = { isSameEntry: (other: unknown) => Promise.resolve(other === file) }
        const visit = await load(world, 'visit', storage, {
            call: (method, result) => {
                if (method === fails) throw new Error(`${fails} unavailable`)
                return method === 'readHandle' && result ? file : result
            },
        })
        const copy = openSession(visit)
        assert.notEqual(copy.forkOf, undefined)
        assert.deepEqual(
            visit.events.find((event) => event.kind === 'separateCopy'),
            { kind: 'separateCopy', of: { name: 'coconut.nxsp', bound: true }, maybe: true },
        )
        lock.release()
    })

test('Duplicate Tab of an unstored continuation forks what it continued', async () => {
    const world = createWorld({ seed: 15 })
    const storage = new MemoryStorage()
    const first = await openJournalPage(world, 'first', storage)
    const a = stateOf(goldenChart())
    const parent = beginSession(first, a)
    await first.flusher.flush({ strict: true })
    first.tab.kill()
    const visit = await load(world, 'visit', storage)
    const continuation = openSession(visit)
    // The live tab holds its continuation; its copy has the same tab record.
    const copy = await load(world, 'copy', storage, { tab: new Map(visit.tab) })
    assert.equal(copy.claim.kind, 'duplicate')
    const fork = openSession(copy)
    assert.notEqual(fork.forkOf, undefined)
    assert.equal(fork.parent?.id, parent.id)
    assert.notEqual(fork.id, continuation.id)
})

// X-13: a chain with no name of its own is named by its date fallback where a copy says what it is a
// copy of, so the source carries when it started and no empty name.
test('a separate copy of an untitled session names its source by when it started', async () => {
    const world = createWorld({ seed: 16 })
    const storage = new MemoryStorage()
    const first = await openJournalPage(world, 'first', storage)
    const titled = stateOf(goldenChart())
    // No title, source name or BGM name: nothing but the date names it.
    const a = { ...titled, levelInfo: { ...titled.levelInfo, title: '' } }
    const parent = beginSession(first, a)
    await first.flusher.flush({ strict: true })
    first.tab.kill()
    const visit = await load(world, 'visit', storage)
    openSession(visit)
    const copy = await load(world, 'copy', storage, { tab: new Map(visit.tab) })
    assert.equal(copy.claim.kind, 'duplicate')
    const event = copy.events.find((each) => each.kind === 'separateCopy')
    assert.deepEqual(event, {
        kind: 'separateCopy',
        of: { name: '', bound: false, at: parent.startedAt },
    })
    assert.equal(typeof parent.startedAt, 'number')
})

test('a copy’s source is its file, else its own name, else the date it started', () => {
    assert.deepEqual(sessionCopyOf('Coconut', 5), { name: 'Coconut', bound: false })
    assert.deepEqual(sessionCopyOf(undefined, 5), { name: '', bound: false, at: 5 })
    assert.deepEqual(sessionCopyOf('', undefined), { name: '', bound: false })
})

test('a reload of a session deleted in the gap continues the recovery session its journal became', async () => {
    const world = createWorld({ seed: 16 })
    const storage = new MemoryStorage()
    const { tab, session, root } = await journalledOnly(world, storage)
    await tamper(world, async (tx) => {
        const chain = (await tx.get('chains', session.chainId)) as Record<string, unknown>
        await tx.put('chains', { ...chain, deleting: { at: 1 } })
    })
    const reload = await load(world, 'reload', storage, { tab })
    const outcome = reload.recovery.ownOutcome
    assert.ok(outcome && 'result' in outcome && outcome.result.kind === 'recovery')
    assert.deepEqual(reload.events.map((event) => event.kind).sort(), [
        'bgmNotLoaded',
        'deletedElsewhere',
        'journalKept',
    ])
    assert.equal(openSession(reload).parent?.id, outcome.result.sessionId)
    assert.equal(rootOf(reload.page.live.state), root)
    assert.equal(journalText(storage, session.id), null)
})

test('without Web Locks, a copy of a hidden tab never takes its key: both go on journalling', async () => {
    const world = createWorld({ seed: 18 })
    const navigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true })
    try {
        const storage = new MemoryStorage()
        const tab: TabStorage = new Map()
        const original = await openJournalPage(
            world,
            'original',
            storage,
            {},
            {
                flags: { noStorage: true },
            },
        )
        const a = stateOf(goldenChart())
        const session = beginSession(original, a, 'new')
        append(original, { kind: 'edit', step: editStep(futureFixtureOperation('Edit')) }, widen(a))
        assert.equal(original.writer.write(), true)
        // Hidden: the marker is in its sessionStorage, which Duplicate Tab copies.
        recordTab(tab, { sessionId: session.id, start: 'new' })
        markUnloaded(tab, session.id)
        const copy = await load(world, 'copy', storage, {
            tab,
            core: { flags: { noStorage: true } },
        })
        assert.equal(copy.claim.kind, 'reload')
        assert.notEqual(openSession(copy).id, session.id)
        append(
            copy.page,
            { kind: 'edit', step: editStep(futureFixtureOperation('In the copy')) },
            widen(a, 3),
        )
        assert.equal(copy.page.writer.write(), true)
        // The original's next edit is journalled as before, never refused.
        append(
            original,
            { kind: 'edit', step: editStep(futureFixtureOperation('In the original')) },
            widen(a, 4),
        )
        assert.equal(original.writer.write(), true)
        assert.ok(storage.getItem(`nse.journal.${session.id}`))
        assert.ok(storage.getItem(`nse.journal.${openSession(copy).id}`))
    } finally {
        if (navigator) Object.defineProperty(globalThis, 'navigator', navigator)
    }
})

test('the writer writes again a key removed behind it, even with nothing new to write', async () => {
    const world = createWorld({ seed: 19 })
    const storage = new MemoryStorage()
    const page = await openJournalPage(world, 'page', storage, {}, { flags: { noStorage: true } })
    const a = stateOf(goldenChart())
    const session = beginSession(page, a, 'new')
    append(page, { kind: 'edit', step: editStep(futureFixtureOperation('Edit')) }, widen(a))
    assert.equal(page.writer.write(), true)
    const key = `nse.journal.${session.id}`
    const text = storage.getItem(key)
    // Another page removes it (a copy's Discard, a stale retire): not covered any more.
    storage.removeItem(key)
    assert.equal(page.writer.verified(session.id, page.flusher.newestSeq(session)), false)
    assert.equal(page.writer.write(), true)
    assert.equal(storage.getItem(key), text)
})

test('a failed own journal a flush covered since goes, and the reload takes up the newer stored session', async () => {
    const world = createWorld({ seed: 20 })
    const storage = new MemoryStorage()
    const tab: TabStorage = new Map()
    const page = await openJournalPage(world, 'first', storage)
    const a = stateOf(goldenChart())
    const session = beginSession(page, a)
    recordTab(tab, { sessionId: session.id, start: 'stored' })
    append(page, { kind: 'edit', step: editStep(futureFixtureOperation('E0')) }, widen(a))
    await page.flusher.flush({ strict: true })
    // A hide's journal, then edits relaxed flushes stored past it.
    append(page, { kind: 'edit', step: editStep(futureFixtureOperation('E1')) }, widen(a, 1))
    assert.equal(page.writer.write(), true)
    append(page, { kind: 'edit', step: editStep(futureFixtureOperation('E2')) }, widen(a, 2))
    append(page, { kind: 'edit', step: editStep(futureFixtureOperation('E3')) }, widen(a, 3))
    await page.flusher.flush()
    const stored = toHex((await readOpen(page, session.id)).head)
    page.tab.kill()
    assert.ok(journalText(storage, session.id))

    // The relaxed flush may not be on disk: a strict commit comes before the key goes.
    const strictWhileKept: boolean[] = []
    world.memory.faults.put = (store) => {
        if (store === 'meta') strictWhileKept.push(journalText(storage, session.id) !== null)
        return undefined
    }
    const reload = await failedReload(world, storage, tab)
    world.memory.faults.put = undefined
    assert.equal(reload.recovery.ownOutcome?.kind, 'failed')
    assert.equal(openSession(reload).id, session.id)
    assert.equal(rootOf(reload.page.live.state), stored)
    assert.ok(strictWhileKept.includes(true))
    assert.equal(journalText(storage, session.id), null)
    assert.deepEqual(reload.recovery.keptForLocalData, [])
    assert.equal(
        reload.events.some(
            (event) => event.kind === 'journalFailed' || event.kind === 'journalRecovered',
        ),
        false,
    )
})

test('a still-failing second reload of an unstored continuation shows its journal’s state again', async () => {
    const world = createWorld({ seed: 21 })
    const storage = new MemoryStorage()
    const { tab, session, root } = await journalledOnly(world, storage)
    const reload = await failedReload(world, storage, tab)
    const continued = openSession(reload)
    assert.equal(reload.page.writer.write(), true)
    assert.equal(journalText(storage, session.id), null)
    reload.page.tab.kill()
    const again = await failedReload(world, storage, tab)
    assert.equal(again.recovery.ownOutcome?.kind, 'failed')
    assert.equal(again.claim.kind === 'reload' && again.claim.record.sessionId, continued.id)
    assert.equal(rootOf(again.page.live.state), root)
    assert.equal(openSession(again).parent?.id, session.id)
    assert.deepEqual(again.recovery.keptForLocalData, [])
})

test('a never-stored blank start whose own journal fails to apply reopens that work', async () => {
    const world = createWorld({ seed: 22 })
    const storage = new MemoryStorage()
    const tab: TabStorage = new Map()
    const page = await openJournalPage(world, 'first', storage)
    const a = stateOf(goldenChart())
    const blank = beginSession(page, a, 'new')
    recordTab(tab, { sessionId: blank.id, start: 'blank' })
    append(page, { kind: 'edit', step: editStep(futureFixtureOperation('Edit')) }, widen(a, 4))
    assert.equal(page.writer.write(), true)
    const root = journalRoot(journalText(storage, blank.id) ?? '', blank.id)
    page.tab.kill()
    const reload = await failedReload(world, storage, tab)
    assert.equal(reload.opened, true)
    assert.equal(rootOf(reload.page.live.state), root)
    assert.ok(reload.events.some((event) => event.kind === 'journalRecovered'))
    // Its key goes once the new session holds the work.
    assert.equal(reload.page.writer.write(), true)
    assert.equal(journalText(storage, blank.id), null)
})

test('starting from a failed own journal keeps the session held until its key goes', async () => {
    const world = createWorld({ seed: 23 })
    const storage = new MemoryStorage()
    const { tab, session } = await journalledOnly(world, storage)
    // Where commits aren't durable on resolve (D14), no commit retires the key.
    const reload = await quiet(() =>
        load(world, 'reload', storage, {
            tab,
            worker: { applyJournal: () => Promise.reject(new Error('QuotaExceededError')) },
            writer: { strictCommits: false },
        }),
    )
    // The continuation's first write is in and moved the head; the key is still there.
    await reload.page.flusher.flush({ strict: true })
    assert.equal(rows(world, 'chains').get(session.chainId)?.head, openSession(reload).id)
    assert.ok(journalText(storage, session.id))
    const other = world.tab('other')
    assert.equal(await other.run(() => claimSessionLock(other.locks, session.id)), undefined)
    // Its own journal holds the work: the key goes, and so does the hold.
    append(
        reload.page,
        { kind: 'edit', step: editStep(futureFixtureOperation('More')) },
        widen(stateOf(goldenChart()), 9),
    )
    assert.equal(reload.page.writer.write(), true)
    assert.equal(journalText(storage, session.id), null)
    const lock = await other.run(() => claimSessionLock(other.locks, session.id))
    assert.ok(lock)
    lock.release()
})

test('a reload whose open fails before it opens anything lets the claim go', async () => {
    const world = createWorld({ seed: 24 })
    const storage = new MemoryStorage()
    const tab: TabStorage = new Map()
    const page = await openJournalPage(world, 'first', storage)
    const a = stateOf(goldenChart())
    const session = beginSession(page, a)
    recordTab(tab, { sessionId: session.id, start: 'stored' })
    append(page, { kind: 'edit', step: editStep(futureFixtureOperation('E0')) }, widen(a))
    await page.flusher.flush({ strict: true })
    page.tab.kill()
    // The worker's answer to the reload's read never comes (a timeout).
    const failing = await quiet(() =>
        load(world, 'reload', storage, {
            tab,
            call: (method, result) => {
                if (method === 'readSession') throw new Error('The worker did not answer')
                return result
            },
        }).then(
            () => undefined,
            (error: unknown) => error,
        ),
    )
    assert.ok(failing instanceof Error)
    // The session lock is free again: Restore in that tab continues it.
    const other = world.tab('other')
    const lock = await other.run(() => claimSessionLock(other.locks, session.id))
    assert.ok(lock)
    lock.release()
})

test('a reload from its own journal that fails before its session takes the lock lets the claim go (LS3-3)', async () => {
    const world = createWorld({ seed: 25 })
    const storage = new MemoryStorage()
    const readOnly = { flags: { readOnly: true } }
    const visit = await load(world, 'visit', storage, { core: readOnly })
    const a = stateOf(goldenChart())
    const session = beginSession(visit.page, a, 'new')
    append(visit.page, { kind: 'edit', step: editStep(futureFixtureOperation('Edit')) }, widen(a))
    assert.equal(visit.page.writer.write(), true)
    visit.page.tab.kill()
    recordTab(visit.tab, { sessionId: session.id, start: 'new' })

    const failing = await quiet(() =>
        load(world, 'reload', storage, {
            tab: visit.tab,
            core: readOnly,
            show: () => {
                throw new Error('The editor could not show the session')
            },
        }).then(
            () => undefined,
            (error: unknown) => error,
        ),
    )
    assert.ok(failing instanceof Error)
    // The session lock is free again: Restore in that tab continues it.
    const other = world.tab('other')
    const lock = await other.run(() => claimSessionLock(other.locks, session.id))
    assert.ok(lock)
    lock.release()
})

test('a stored stack whose window starts after slot 0 opens saying earlier steps are in History', async () => {
    for (const base of [0, 1]) {
        const world = createWorld({ seed: 20 + base })
        const storage = new MemoryStorage()
        const first = await openJournalPage(world, 'first', storage)
        const a = stateOf(goldenChart())
        const stored = beginSession(first, a)
        append(first, { kind: 'edit', step: editStep(futureFixtureOperation('One')) }, widen(a))
        append(first, { kind: 'edit', step: editStep(futureFixtureOperation('Two')) }, widen(a, 1))
        await first.flusher.flush({ strict: true })
        // As a capped stack stores it: the window's first slot is past slot 0.
        if (base) {
            const row = rows(world, 'sessions').get(stored.id)!
            const window = row.stack as { base: number; length: number; index: number }
            await first.tab.run(() =>
                first.core.write(['sessions'], (tx) =>
                    tx.put('sessions', {
                        ...row,
                        stack: { ...window, base, length: window.length - base },
                    }),
                ),
            )
        }
        first.tab.kill()
        const visit = await load(world, 'visit', storage)
        assert.equal(visit.opened, true)
        assert.equal(visit.shown.at(-1)?.earlier, base ? true : undefined)
    }
})
