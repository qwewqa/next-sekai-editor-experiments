import assert from 'node:assert/strict'
import test from 'node:test'
import { writeMeta } from '../../../src/local/db'
import { sha256, toHex } from '../../../src/local/hash'
import { journalHandlers } from '../../../src/local/journal/handlers'
import {
    JOURNAL_TOTAL_LIMIT,
    MemoryStorage,
    storageJournalStore,
} from '../../../src/local/journal/store'
import { holdSessionLock } from '../../../src/local/sessions'
import type { LoadEvent } from '../../../src/local/startup/events'
import {
    AUTO_SAVE_KEY,
    LEGACY_RECOVERY_KEY,
    writeLegacyRecovery,
} from '../../../src/local/startup/legacy'
import { RecoverySteps } from '../../../src/local/startup/recovery'
import { recoverySteps, runRecovery, type RecoveryContext } from '../../../src/local/startup/steps'
import { checkStored } from '../../../src/local/testing/invariants'
import { createWorld, type Tab, type World } from '../../../src/local/testing/world'
import type { StorageCore } from '../../../src/local/worker/core'
import { startupHandlers } from '../../../src/local/worker/startupHandlers'
import {
    editStep,
    futureFixtureOperation,
    nativeOperation,
    originOperation,
} from '../../helpers/historySteps'
import { rows, testId, workerCore } from '../flush/harness'
import { append, beginSession, openJournalPage } from '../journal/harness'
import { goldenChart, stateOf } from '../records/charts'
import { widen } from '../timeline/helpers'
import { autoSaveText } from './autoSaveText'

// The recovery order on start (Part 0 §0.9.8; Part 1 §1.6.9, §1.6.4 #7, §1.8) on the test core:
// the canary, the journals, then the old auto save, with the step list's insertion points.

const PREFIX = 'nse.'

/** A load's recovery context in a tab, over `storage` as its localStorage. */
const loadIn = async (
    world: World,
    tab: Tab,
    storage: MemoryStorage,
    extra: Partial<RecoveryContext> = {},
    core: StorageCore = workerCore(world, tab),
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
        journal: storageJournalStore(() => storage, PREFIX),
        storage: () => storage,
        prefix: PREFIX,
        appVersion: '0.6.0',
        safe: false,
        operations: {
            recovered: (droppedSteps) =>
                nativeOperation(
                    { id: 'nse.recovery', data: { source: 'journal', droppedSteps } },
                    'Recovered last change',
                ),
            migrated: originOperation('autoSave'),
        },
        newId: testId,
        now: () => 1_792_130_500_000,
        outcomes: [],
        keptForLocalData: [],
        events: (event) => events.push(event),
        ...extra,
    }
    return { recovery, events, core, startup }
}

const autoSaveOf = autoSaveText

const key = (name: string) => PREFIX + name

test('the step list runs the canary, the journals and the migration in order, with insertion points', async () => {
    assert.deepEqual(recoverySteps.names(), ['canary', 'journals', 'legacyMigration'])
    const ran: string[] = []
    const step = (name: string) => ({ name, run: () => void ran.push(name) })
    const steps = new RecoverySteps([step('canary'), step('journals'), step('legacyMigration')])
    steps.addRecoveryStep(step('triage'), { at: 'afterAll' })
    steps.addRecoveryStep(step('origin'), { at: 'afterCanary' })
    steps.replaceStep('canary', step('detectOnly'))
    await steps.run({})
    assert.deepEqual(ran, ['detectOnly', 'origin', 'journals', 'legacyMigration', 'triage'])
    assert.throws(() => steps.addRecoveryStep(step('journals'), { at: 'afterAll' }))
    // Safe mode skips the restoring steps.
    ran.length = 0
    await steps.run({}, (name) => name !== 'detectOnly')
    assert.deepEqual(ran, ['detectOnly'])
})

test('the canary: only IndexedDB cleared gives the cleared-storage event', async () => {
    const world = createWorld({ seed: 1 })
    const storage = new MemoryStorage()
    // A first visit: no event, the canary and deviceId written.
    const first = await loadIn(world, world.tab('a'), storage)
    await runRecovery(first.recovery)
    assert.deepEqual(first.events, [])
    const canary = JSON.parse(storage.getItem(key('canary'))!) as string
    const deviceId = JSON.parse(storage.getItem(key('deviceId'))!) as string
    assert.equal(typeof canary, 'string')

    // Only localStorage cleared: no event, and deviceId comes back from meta.
    storage.removeItem(key('canary'))
    storage.removeItem(key('deviceId'))
    const second = await loadIn(world, world.tab('b'), storage)
    await runRecovery(second.recovery)
    assert.deepEqual(second.events, [])
    assert.equal(JSON.parse(storage.getItem(key('deviceId'))!), deviceId)
    assert.equal(JSON.parse(storage.getItem(key('canary'))!), canary)

    // Only IndexedDB cleared (a new database, so a new id): the event, and the new id kept.
    const cleared = createWorld({ seed: 2 })
    const third = await loadIn(cleared, cleared.tab('c'), storage)
    await runRecovery(third.recovery)
    assert.deepEqual(third.events, [{ kind: 'storageCleared' }])
    assert.notEqual(JSON.parse(storage.getItem(key('canary'))!), canary)
})

test('safe mode writes no canary and runs neither the journals nor the migration', async () => {
    const world = createWorld({ seed: 3 })
    const storage = new MemoryStorage()
    storage.setItem(key(AUTO_SAVE_KEY), autoSaveOf(stateOf(goldenChart())))
    const { recovery, events } = await loadIn(world, world.tab('a'), storage, { safe: true })
    await runRecovery(recovery)
    assert.deepEqual(events, [])
    assert.equal(storage.getItem(key('canary')), null)
    assert.notEqual(storage.getItem(key(AUTO_SAVE_KEY)), null)
    assert.equal(rows(world, 'sessions').size, 0)
})

test('the migration: a readable slot becomes a session, copied into the legacy slot before the key goes', async () => {
    const world = createWorld({ seed: 4 })
    const storage = new MemoryStorage()
    const state = stateOf(goldenChart())
    const text = autoSaveOf(state)
    storage.setItem(key(AUTO_SAVE_KEY), text)
    const { recovery, events, startup } = await loadIn(world, world.tab('a'), storage)
    await runRecovery(recovery)

    assert.ok(recovery.migrated)
    // Its line waits for the open (`openAtStart`), which knows whether it's what opened.
    assert.deepEqual(events, [])
    assert.deepEqual(recovery.migrated.name.name, { kind: 'source', text: 'coconut' })
    const migrated = recovery.migrated.sessionId
    const session = rows(world, 'sessions').get(migrated)
    assert.ok(session)
    assert.equal(session.origin, 'migrated')
    assert.equal(session.lastSeq, 1)
    const chain = rows(world, 'chains').get(session.chainId as string)
    assert.ok(chain)
    assert.equal(chain.head, migrated)
    // The import rule: no Name, the slot's file name as the source's; edited, since it's in no file.
    assert.equal('name' in chain, false)
    assert.equal(chain.sourceName, 'coconut')
    assert.equal(chain.edited, true)
    assert.equal(chain.hasContent, true)
    assert.equal('file' in chain, false)
    const [entry] = [...rows(world, 'entries').values()]
    assert.equal(entry?.kind, 'init')
    assert.deepEqual(entry?.operation, originOperation('autoSave'))
    // Deduplication by the slot's content hash.
    const meta = rows(world, 'meta').get('migratedHashes')
    assert.deepEqual(meta?.value, [toHex(await sha256(new TextEncoder().encode(text)))])
    // The insurance copy holds the slot's value as it was, and the old key is gone.
    assert.equal(storage.getItem(key(LEGACY_RECOVERY_KEY)), text)
    assert.equal(storage.getItem(key(AUTO_SAVE_KEY)), null)
    // The migrated session is the one a first load continues.
    const newest = await world.tab('a').run(() => startup.readNewestSession(undefined))
    assert.equal(newest.read?.session.id, migrated)
    assert.deepEqual(checkStored(world.memory), [])
})

test('the migration runs on every load: an old tab’s write-back makes no second session, and a newer slot makes one', async () => {
    const world = createWorld({ seed: 5 })
    const storage = new MemoryStorage()
    const state = stateOf(goldenChart())
    const text = autoSaveOf(state)
    storage.setItem(key(AUTO_SAVE_KEY), text)
    await runRecovery((await loadIn(world, world.tab('a'), storage)).recovery)
    assert.equal(rows(world, 'sessions').size, 1)

    // An old tab writes the same value back: skipped by the hash set, and deleted.
    storage.setItem(key(AUTO_SAVE_KEY), text)
    const again = await loadIn(world, world.tab('b'), storage)
    await runRecovery(again.recovery)
    assert.equal(again.recovery.migrated, undefined)
    assert.deepEqual(again.events, [])
    assert.equal(rows(world, 'sessions').size, 1)
    assert.equal(storage.getItem(key(AUTO_SAVE_KEY)), null)

    // An old tab's newer write is migrated by the next load.
    storage.setItem(key(AUTO_SAVE_KEY), autoSaveOf(widen(state)))
    const newer = await loadIn(world, world.tab('c'), storage)
    await runRecovery(newer.recovery)
    assert.ok(newer.recovery.migrated)
    assert.equal(rows(world, 'sessions').size, 2)
    assert.deepEqual(checkStored(world.memory), [])
})

test('the migration deletes the key only if its value is unchanged since it was read', async () => {
    const world = createWorld({ seed: 6 })
    const storage = new MemoryStorage()
    const state = stateOf(goldenChart())
    storage.setItem(key(AUTO_SAVE_KEY), autoSaveOf(state))
    const newer = autoSaveOf(widen(state))
    const { recovery } = await loadIn(world, world.tab('a'), storage)
    const migrate = recovery.worker.migrateAutoSave
    // An old tab writes while the transaction runs.
    recovery.worker.migrateAutoSave = async (batch) => {
        const result = await migrate(batch)
        storage.setItem(key(AUTO_SAVE_KEY), newer)
        return result
    }
    await runRecovery(recovery)
    assert.ok(recovery.migrated)
    assert.equal(storage.getItem(key(AUTO_SAVE_KEY)), newer)
})

test('an unreadable or absent slot makes no session, and an unreadable one stays', async () => {
    const world = createWorld({ seed: 7 })
    const storage = new MemoryStorage()
    const absent = await loadIn(world, world.tab('a'), storage)
    await runRecovery(absent.recovery)
    assert.deepEqual(absent.events, [])
    storage.setItem(key(AUTO_SAVE_KEY), '{"version":1,"levelData":"not base64 gzip')
    const unreadable = await loadIn(world, world.tab('b'), storage)
    await runRecovery(unreadable.recovery)
    // Never blank without a word (§1.8 step 3's aim): Local Data offers it.
    assert.deepEqual(unreadable.events, [{ kind: 'migrationFailed', unreadable: true }])
    assert.equal(rows(world, 'sessions').size, 0)
    assert.notEqual(storage.getItem(key(AUTO_SAVE_KEY)), null)
    assert.equal(storage.getItem(key(LEGACY_RECOVERY_KEY)), null)
})

test('a failed migration transaction leaves the key, with its load event', async () => {
    const world = createWorld({ seed: 8 })
    const storage = new MemoryStorage()
    storage.setItem(key(AUTO_SAVE_KEY), autoSaveOf(stateOf(goldenChart())))
    const tab = world.tab('a')
    const core = workerCore(world, tab, { flags: { forceQuota: true } })
    const errors = console.error
    console.error = () => undefined
    try {
        const { recovery, events } = await loadIn(world, tab, storage, {}, core)
        await runRecovery(recovery)
        assert.deepEqual(
            events.map((event) => event.kind),
            ['migrationFailed'],
        )
    } finally {
        console.error = errors
    }
    assert.notEqual(storage.getItem(key(AUTO_SAVE_KEY)), null)
    assert.equal(rows(world, 'sessions').size, 0)
})

test('without IndexedDB the old slot and earlier visits’ journals stay for Local Data, never loaded', async () => {
    const world = createWorld({ seed: 9 })
    const storage = new MemoryStorage()
    storage.setItem(key(AUTO_SAVE_KEY), autoSaveOf(stateOf(goldenChart())))
    // An earlier visit's journal, written while storage was unavailable.
    const earlier = await openJournalPage(world, 'earlier', storage)
    const a = stateOf(goldenChart())
    beginSession(earlier, a, 'new')
    append(earlier, { kind: 'edit', step: editStep(futureFixtureOperation('Edit')) }, widen(a))
    assert.equal(earlier.writer.write(), true)

    const tab = world.tab('unavailable')
    const core = workerCore(world, tab, { flags: { noStorage: true } })
    const { recovery, events } = await loadIn(world, tab, storage, {}, core)
    await runRecovery(recovery)
    assert.deepEqual(
        events.map((event) => event.kind),
        ['unsavedInLocalData'],
    )
    assert.equal(recovery.keptForLocalData.length, 1)
    assert.notEqual(storage.getItem(key(AUTO_SAVE_KEY)), null)
    assert.equal((await recovery.journal.read()).length, 1)
})

test('one load runs all three: the canary, a journal replayed, then the migration', async () => {
    const world = createWorld({ seed: 10 })
    const storage = new MemoryStorage()
    // A killed tab's journal, and an old auto save from before the update.
    const killed = await openJournalPage(world, 'killed', storage)
    const a = stateOf(goldenChart())
    const session = beginSession(killed, a)
    await killed.flusher.flush()
    append(killed, { kind: 'edit', step: editStep(futureFixtureOperation('Edit')) }, widen(a))
    assert.equal(killed.writer.write(), true)
    storage.setItem(key(AUTO_SAVE_KEY), autoSaveOf(widen(a, 2)))
    storage.setItem(key('canary'), JSON.stringify('another database'))

    const { recovery, events } = await loadIn(world, world.tab('next'), storage)
    await runRecovery(recovery)
    assert.deepEqual(
        events.map((event) => event.kind),
        ['storageCleared', 'journalRecovered'],
    )
    assert.equal(rows(world, 'sessions').get(session.id)?.lastSeq, 2)
    assert.equal((await recovery.journal.read()).length, 0)
    assert.ok(recovery.migrated)
    assert.deepEqual(checkStored(world.memory), [])
})

test('a migrated session’s hash is checked in its transaction: a slot migrated meanwhile makes no second session', async () => {
    const world = createWorld({ seed: 11 })
    const storage = new MemoryStorage()
    const text = autoSaveOf(stateOf(goldenChart()))
    storage.setItem(key(AUTO_SAVE_KEY), text)
    const { recovery, core } = await loadIn(world, world.tab('a'), storage)
    // Another tab migrated the same slot first.
    const hash = toHex(await sha256(new TextEncoder().encode(text)))
    await world
        .tab('a')
        .run(() => core.write(['meta'], (tx) => writeMeta(tx, 'migratedHashes', [hash])))
    await runRecovery(recovery)
    assert.equal(recovery.migrated, undefined)
    assert.equal(rows(world, 'sessions').size, 0)
})

test('a journal of a chain marked for Delete becomes a recovery session, never swept unseen', async () => {
    const world = createWorld({ seed: 12 })
    const storage = new MemoryStorage()
    const killed = await openJournalPage(world, 'killed', storage)
    const a = stateOf(goldenChart())
    const session = beginSession(killed, a)
    await killed.flusher.flush()
    append(killed, { kind: 'edit', step: editStep(futureFixtureOperation('Edit')) }, widen(a))
    assert.equal(killed.writer.write(), true)
    const tab = world.tab('next')
    const { recovery, events, core } = await loadIn(world, tab, storage)
    await tab.run(() =>
        core.write(['chains'], async (tx) => {
            const chain = (await tx.get('chains', session.chainId)) as Record<string, unknown>
            await tx.put('chains', { ...chain, deleting: { at: 1 } })
        }),
    )
    await runRecovery(recovery)
    assert.deepEqual(
        events.map((event) => event.kind),
        ['journalKept'],
    )
    assert.equal((await recovery.journal.read()).length, 0)
    const outcome = recovery.outcomes[0]
    assert.ok(outcome && 'result' in outcome && outcome.result.kind === 'recovery')
    assert.equal(rows(world, 'chains').get(outcome.result.chainId)?.head, outcome.result.sessionId)
    assert.deepEqual(checkStored(world.memory), [])
})

test('a slot migrated before is never parsed again: an old tab’s write-back only goes', async () => {
    const world = createWorld({ seed: 13 })
    const storage = new MemoryStorage()
    const text = autoSaveOf(stateOf(goldenChart()))
    storage.setItem(key(AUTO_SAVE_KEY), text)
    const first = await loadIn(world, world.tab('a'), storage)
    await runRecovery(first.recovery)
    assert.ok(first.recovery.migrated)
    // Written back, with no legacy copy left: the copy is made again before the key goes.
    storage.setItem(key(AUTO_SAVE_KEY), text)
    storage.removeItem(key(LEGACY_RECOVERY_KEY))
    const again = await loadIn(world, world.tab('b'), storage)
    again.recovery.worker.migrateAutoSave = () => {
        throw new Error('A migrated slot is never prepared again')
    }
    await runRecovery(again.recovery)
    assert.deepEqual(again.events, [])
    assert.equal(again.recovery.migrated, undefined)
    assert.equal(storage.getItem(key(LEGACY_RECOVERY_KEY)), text)
    assert.equal(storage.getItem(key(AUTO_SAVE_KEY)), null)
})

test('a slot whose batch can’t be made stays, with its load event, and never stops the load', async () => {
    const world = createWorld({ seed: 14 })
    const storage = new MemoryStorage()
    storage.setItem(key(AUTO_SAVE_KEY), autoSaveOf(stateOf(goldenChart())))
    const { recovery, events } = await loadIn(world, world.tab('a'), storage, {
        newId: () => {
            throw new Error('A bug in the batch')
        },
    })
    const errors = console.error
    console.error = () => undefined
    try {
        await runRecovery(recovery)
    } finally {
        console.error = errors
    }
    assert.deepEqual(events, [{ kind: 'migrationFailed', unreadable: true }])
    assert.notEqual(storage.getItem(key(AUTO_SAVE_KEY)), null)
})

test('a migrated auto save from an older engine revision says so (D18)', async () => {
    const world = createWorld({ seed: 15 })
    const storage = new MemoryStorage()
    // The golden chart has elevation, which the revision change can matter to.
    const text = autoSaveOf(stateOf(goldenChart()), 'coconut', (levelData) => {
        const [initialization] = levelData.entities
        if (initialization)
            initialization.data = initialization.data.filter((data) => data.name !== 'revision')
    })
    storage.setItem(key(AUTO_SAVE_KEY), text)
    const { recovery, events } = await loadIn(world, world.tab('a'), storage)
    await runRecovery(recovery)
    assert.ok(recovery.migrated)
    assert.deepEqual(events, [{ kind: 'migratedRevision', sessionId: recovery.migrated.sessionId }])
})

test('the canary: a database without its meta row where localStorage has an id is cleared too', async () => {
    const world = createWorld({ seed: 16 })
    const storage = new MemoryStorage()
    storage.setItem(key('canary'), JSON.stringify('an earlier database'))
    const { recovery, events } = await loadIn(world, world.tab('a'), storage)
    recovery.worker.readMetaIds = () => Promise.resolve({})
    await runRecovery(recovery)
    assert.deepEqual(events, [{ kind: 'storageCleared' }])
})

test('storage unavailable: a live tab’s journal isn’t offered, and earlier journals filling their budget say so', async () => {
    const world = createWorld({ seed: 17 })
    const storage = new MemoryStorage()
    const live = await openJournalPage(world, 'live', storage, {}, { flags: { noStorage: true } })
    const a = stateOf(goldenChart())
    const session = beginSession(live, a, 'new')
    append(live, { kind: 'edit', step: editStep(futureFixtureOperation('Edit')) }, widen(a))
    assert.equal(live.writer.write(), true)
    const lock = holdSessionLock(live.tab.locks, session.id)
    await live.tab.run(() => lock.granted)

    const tab = world.tab('next')
    const core = workerCore(world, tab, { flags: { noStorage: true } })
    const first = await loadIn(world, tab, storage, {}, core)
    await runRecovery(first.recovery)
    assert.deepEqual(first.recovery.keptForLocalData, [])
    assert.deepEqual(first.events, [])

    // Earlier visits' journals over half the budget.
    storage.setItem(key('journal.earlier'), 'x'.repeat(JOURNAL_TOTAL_LIMIT / 2))
    const second = await loadIn(world, tab, storage, {}, core)
    await runRecovery(second.recovery)
    assert.deepEqual(
        second.events.map((event) => event.kind),
        ['unsavedInLocalData', 'journalsFull'],
    )
    lock.release()
})

test('the legacy slot counts only when it reads back intact', () => {
    // A storage that hands back something else than was written.
    class Changing extends MemoryStorage {
        override getItem(name: string) {
            return name.endsWith(LEGACY_RECOVERY_KEY) ? 'other' : super.getItem(name)
        }
    }
    const text = '{"bgmOffset":0,"entities":[]}'
    assert.equal(writeLegacyRecovery(text, new Changing(), PREFIX), false)
    assert.equal(writeLegacyRecovery(text, new MemoryStorage(), PREFIX), true)
})

test('a failed worker read in the canary or the migration’s dedupe never stops the load', async () => {
    const world = createWorld({ seed: 19 })
    const storage = new MemoryStorage()
    storage.setItem(key('canary'), JSON.stringify('an earlier database'))
    storage.setItem(key(AUTO_SAVE_KEY), autoSaveOf(stateOf(goldenChart())))
    const { recovery, events } = await loadIn(world, world.tab('a'), storage)
    recovery.worker.readMetaIds = () => Promise.reject(new Error('The connection closed'))
    recovery.worker.migratedBefore = () => Promise.reject(new Error('The connection closed'))
    await runRecovery(recovery)
    // The canary says nothing either way; the transaction's own check decides the migration.
    assert.deepEqual(events, [])
    assert.ok(recovery.migrated)
    assert.equal(storage.getItem(key(AUTO_SAVE_KEY)), null)
})
