import assert from 'node:assert/strict'
import test from 'node:test'
import { toHex } from '../../../src/local/hash'
import { journalState } from '../../../src/local/journal/content'
import { readJournal, type Journal } from '../../../src/local/journal/format'
import { journalHandlers } from '../../../src/local/journal/handlers'
import { MemoryStorage, storageJournalStore } from '../../../src/local/journal/store'
import { toRecords } from '../../../src/local/records/records'
import { encodeSnapshot } from '../../../src/local/records/snapshot'
import { holdSessionLock } from '../../../src/local/sessions'
import type { LoadEvent } from '../../../src/local/startup/events'
import { journalledSession } from '../../../src/local/startup/resume'
import { runRecovery, type RecoveryContext } from '../../../src/local/startup/steps'
import { checkStored } from '../../../src/local/testing/invariants'
import { createWorld, type Tab, type World } from '../../../src/local/testing/world'
import type { StorageCore } from '../../../src/local/worker/core'
import { startupHandlers } from '../../../src/local/worker/startupHandlers'
import type { State } from '../../../src/state'
import {
    editStep,
    futureFixtureOperation,
    nativeOperation,
    originOperation,
} from '../../helpers/historySteps'
import { rows, testId, workerCore } from '../flush/harness'
import { append, beginSession, openJournalPage, type JournalPage } from '../journal/harness'
import { goldenChart, stateOf } from '../records/charts'
import { sampleState } from '../records/samples'
import { widen } from '../timeline/helpers'

// Journals while storage is unavailable: never cleared, a
// same-tab reload continuing from its own, two tabs keeping their own, and an earlier visit's
// recovered as a session once IndexedDB works again.

const rootOf = (state: State) => toHex(encodeSnapshot(toRecords(state)).root.hash)

const journalOf = (storage: MemoryStorage, sessionId: string) => {
    const text = storage.getItem(`nse.journal.${sessionId}`)
    assert.ok(text, 'a journal was written')
    return JSON.parse(text) as Journal
}

const journalKeys = (storage: MemoryStorage) =>
    Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter((key) =>
        key?.startsWith('nse.journal.'),
    ).length

const unavailable = (world: World, name: string, storage: MemoryStorage) =>
    openJournalPage(world, name, storage, {}, { flags: { noStorage: true } })

/** A load's recovery in a tab, over `storage`. */
const recover = async (
    world: World,
    tab: Tab,
    storage: MemoryStorage,
    core: StorageCore = workerCore(world, tab),
    own?: string,
) => {
    await tab.run(() => core.start())
    const context = { core, test: true, emit: () => undefined }
    const journal = journalHandlers(context, tab.waiter)
    const startup = startupHandlers(context, tab.waiter)
    const events: LoadEvent[] = []
    const recovery: RecoveryContext = {
        worker: {
            applyJournal: (batch) => tab.run(() => journal.applyJournal(batch)),
            keepRecovered: (item) => tab.run(() => journal.keepRecovered(item)),
            readMetaIds: () => tab.run(() => startup.readMetaIds()),
            migratedBefore: (hash) => tab.run(() => startup.migratedBefore(hash)),
            migrateAutoSave: (batch) => tab.run(() => startup.migrateAutoSave(batch)),
        },
        status: core.status,
        locks: tab.locks,
        journal: storageJournalStore(() => storage, 'nse.'),
        storage: () => storage,
        prefix: 'nse.',
        appVersion: '0.6.0',
        safe: false,
        operations: {
            recovered: (droppedSteps) =>
                nativeOperation(
                    { id: 'nse.recovery', data: { droppedSteps } },
                    'Recovered last change',
                ),
            migrated: originOperation('autoSave'),
        },
        newId: testId,
        ...(own ? { own } : {}),
        outcomes: [],
        keptForLocalData: [],
        events: (event) => events.push(event),
    }
    await runRecovery(recovery)
    return { recovery, events }
}

/** The page's session taken up from its own journal, as a reload while unavailable does. */
const reloadFromJournal = async (page: JournalPage, storage: MemoryStorage, sessionId: string) => {
    const found = (await storageJournalStore(() => storage, 'nse.').read()).find(
        (each) => each.sessionId === sessionId,
    )
    assert.ok(found)
    const session = journalledSession(found)
    assert.ok(session)
    // Loaded: the page goes on writing this key.
    page.store.adopt(found)
    page.live.state = session.state
    return page.flusher.resumeJournalled({
        ...session,
        operation: nativeOperation(
            {
                id: 'nse.recovery',
                data: {
                    droppedSteps:
                        session.recoveryContext.dropped.length + session.recoveryContext.omitted,
                },
            },
            'Recovered last change',
        ),
    })
}

test('storage unavailable, edit, reload, edit: the reload continues from its own journal, which then holds both edits', async () => {
    const world = createWorld({ seed: 1 })
    const storage = new MemoryStorage()
    const first = await unavailable(world, 'tab', storage)
    // A chart read from level data: every value survives the journal's level data.
    const a = sampleState('tests/fixtures/generated-large.json')
    const session = beginSession(first, a, 'new')
    const b = widen(a)
    append(first, { kind: 'edit', step: editStep(futureFixtureOperation('First edit')) }, b)
    await first.flusher.flush()
    assert.equal(first.writer.write(), true)
    const before = journalOf(storage, session.id)
    assert.equal(before.seq, 2)
    assert.equal(before.stack.keep, 0)

    // The reload: its own journal found while storage is unavailable, and continued.
    const { recovery } = await recover(
        world,
        world.tab('reload'),
        storage,
        workerCore(world, world.tab('reload'), { flags: { noStorage: true } }),
        session.id,
    )
    assert.equal(recovery.ownJournal?.sessionId, session.id)
    assert.equal(recovery.keptForLocalData.length, 0)
    const second = await unavailable(world, 'reloaded', storage)
    const resumed = await reloadFromJournal(second, storage, session.id)
    assert.equal(resumed.id, session.id)
    assert.equal(resumed.chainId, session.chainId)
    const c = widen(b, 1)
    append(second, { kind: 'edit', step: editStep(futureFixtureOperation('Second edit')) }, c)
    await second.flusher.flush()
    assert.equal(second.writer.write(), true)

    // The same key, newer: the state holds both edits; never cleared in memory mode.
    const after = journalOf(storage, session.id)
    assert.ok(after.seq > before.seq)
    assert.equal(after.descriptor.chainId, session.chainId)
    const read = readJournal(JSON.stringify(after), session.id)
    assert.equal(read.kind, 'journal')
    const content = journalState(after)
    assert.equal(content.kind, 'state')
    if (content.kind === 'state') assert.equal(rootOf(content.state), rootOf(c))
    assert.equal(journalKeys(storage), 1)
})

test('two tabs keep separate journals while storage is unavailable', async () => {
    const world = createWorld({ seed: 2 })
    const storage = new MemoryStorage()
    const pages = [await unavailable(world, 'a', storage), await unavailable(world, 'b', storage)]
    const a = stateOf(goldenChart())
    const sessions = pages.map((page, i) => {
        const session = beginSession(page, a, 'new')
        append(
            page,
            { kind: 'edit', step: editStep(futureFixtureOperation(`Edit ${i}`)) },
            widen(a, i),
        )
        return session
    })
    for (const page of pages) assert.equal(page.writer.write(), true)
    assert.equal(journalOf(storage, sessions[0]!.id).sessionId, sessions[0]!.id)
    assert.equal(journalOf(storage, sessions[1]!.id).sessionId, sessions[1]!.id)
})

test('a journal written with storage unavailable becomes a session and chain at a load with storage, its key deleted, with its load event', async () => {
    const world = createWorld({ seed: 3 })
    const storage = new MemoryStorage()
    const page = await unavailable(world, 'tab', storage)
    const a = stateOf(goldenChart())
    const session = beginSession(page, a, 'new')
    const b = widen(a)
    append(page, { kind: 'edit', step: editStep(futureFixtureOperation('Edit')) }, b)
    assert.equal(page.writer.write(), true)

    const { events, recovery } = await recover(world, world.tab('next'), storage)
    assert.deepEqual(events, [{ kind: 'unsavedRecovered', sessionId: session.id }])
    const row = rows(world, 'sessions').get(session.id)
    assert.ok(row)
    assert.equal(row.chainId, session.chainId)
    assert.equal(rows(world, 'chains').get(session.chainId)?.head, session.id)
    assert.equal(journalKeys(storage), 0)
    assert.equal(recovery.outcomes[0]?.kind, 'applied')
    assert.deepEqual(checkStored(world.memory), [])
})

test('a journal of a live tab is left alone', async () => {
    const world = createWorld({ seed: 4 })
    const storage = new MemoryStorage()
    const page = await unavailable(world, 'live', storage)
    const a = stateOf(goldenChart())
    const session = beginSession(page, a, 'new')
    append(page, { kind: 'edit', step: editStep(futureFixtureOperation('Edit')) }, widen(a))
    assert.equal(page.writer.write(), true)
    const lock = holdSessionLock(page.tab.locks, session.id)
    await page.tab.run(() => lock.granted)

    const { events, recovery } = await recover(world, world.tab('next'), storage)
    assert.deepEqual(events, [])
    assert.deepEqual(
        recovery.outcomes.map((outcome) => outcome.kind),
        ['live'],
    )
    assert.equal(journalKeys(storage), 1)
    assert.equal(rows(world, 'sessions').size, 0)
    lock.release()
})
