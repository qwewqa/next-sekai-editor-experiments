import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import type { FlushSession } from '../../../src/local/flush'
import { toHex } from '../../../src/local/hash'
import { journalState } from '../../../src/local/journal/content'
import { readJournal } from '../../../src/local/journal/format'
import { MemoryStorage } from '../../../src/local/journal/store'
import { toRecords } from '../../../src/local/records/records'
import { encodeSnapshot } from '../../../src/local/records/snapshot'
import { holdSessionLock } from '../../../src/local/sessions'
import {
    discardRecoveryItem,
    leftSession,
    openRecoveryAutoSave,
    openRecoveryJournal,
    previousSession,
    recoveryFile,
    recoveryItems,
    reopenSession,
    restoreAsCopy,
    setSessionContext,
} from '../../../src/local/startup/api'
import { AUTO_SAVE_KEY, LEGACY_RECOVERY_KEY } from '../../../src/local/startup/legacy'
import { createWorld, type World } from '../../../src/local/testing/world'
import type { State } from '../../../src/state'
import { storageKey } from '../../../src/storage'
import { rows } from '../flush/harness'
import { append, beginSession, openJournalPage } from '../journal/harness'
import { goldenChart, stateOf } from '../records/charts'
import { widen } from '../timeline/helpers'
import { autoSaveText } from './autoSaveText'
import { load, openSession } from './load'

const rootOf = (state: State) => toHex(encodeSnapshot(toRecords(state)).root.hash)

// What the UI acts on after startup (Part 1 §1.4.1, §1.4.14) on the test core: Reopen and Restore
// as a Copy, and Settings › Local Data › Recovery's rows.

/** The page's localStorage, under the editor's own prefix, as Local Data reads it. */
const local = new MemoryStorage()
Object.defineProperty(globalThis, 'localStorage', { value: local, configurable: true })

afterEach(() => {
    for (let i = local.length - 1; i >= 0; i--) local.removeItem(local.key(i) ?? '')
    previousSession.value = undefined
})

test('Reopen right after a switch continues the session left, and offers the one it replaced', async () => {
    const world = createWorld({ seed: 1 })
    const storage = new MemoryStorage()
    const first = await openJournalPage(world, 'first', storage)
    await first.tab.run(() => Promise.resolve())
    first.tab.kill()
    const loaded = await load(world, 'tab', storage)
    const { page } = loaded
    // A stored session, holding its lock as a tab does, then New. Web Locks let it go a little
    // after the session is let go.
    const a = stateOf(goldenChart())
    const lock = holdSessionLock(page.tab.locks, 'left')
    await page.tab.run(() => lock.granted)
    const release = () => {
        setTimeout(lock.release, 100)
    }
    const left = beginSession(page, a, 'import', { id: 'left', done: release })
    append(page, 'edit', 'Edit', widen(a))
    await page.flusher.flush({ strict: true })
    const replacing = beginSession(page, widen(a, 4), 'new')
    leftSession(left.id, { kind: 'date' }, 0, page.flusher.outgoing)
    const lefts: FlushSession[] = []
    setSessionContext({ ...loaded.deps, onLeft: (each) => lefts.push(each) }, loaded.recovery)

    const result = await page.tab.run(() => reopenSession())
    assert.deepEqual(result, { opened: true })
    const reopened = openSession(loaded)
    assert.equal(reopened.continuation, true)
    assert.equal(reopened.forkOf, undefined)
    assert.equal(reopened.parent?.id, left.id)
    assert.deepEqual(
        lefts.map((each) => each.id),
        [replacing.id],
    )
    assert.equal(previousSession.value, undefined)
    // Nothing left to reopen says why.
    assert.deepEqual(await reopenSession(), { opened: false, why: 'none' })
})

test('Reopen of a session deleted since says so', async () => {
    const world = createWorld({ seed: 2 })
    const storage = new MemoryStorage()
    const loaded = await load(world, 'tab', storage)
    setSessionContext(loaded.deps, loaded.recovery)
    leftSession('gone', { kind: 'date' }, 0, Promise.resolve(true))
    assert.deepEqual(await loaded.page.tab.run(() => reopenSession()), {
        opened: false,
        why: 'missing',
    })
})

test('Restore as a Copy forks the session open in another tab', async () => {
    const world = createWorld({ seed: 3 })
    const storage = new MemoryStorage()
    const other = await openJournalPage(world, 'other', storage)
    const a = stateOf(goldenChart())
    const lock = holdSessionLock(other.tab.locks, 'elsewhere')
    await other.tab.run(() => lock.granted)
    const session = beginSession(other, a, 'import', { id: 'elsewhere' })
    await other.flusher.flush({ strict: true })
    const loaded = await load(world, 'tab', storage)
    assert.ok(loaded.events.some((event) => event.kind === 'openElsewhere'))
    setSessionContext(loaded.deps, loaded.recovery)
    assert.equal(await loaded.page.tab.run(() => restoreAsCopy(session.id)), true)
    const copy = openSession(loaded)
    assert.notEqual(copy.forkOf, undefined)
    assert.equal(copy.parent?.id, session.id)
    assert.equal(rows(world, 'chains').get(session.chainId)?.head, session.id)
    lock.release()
})

test('Local Data’s rows: Discard removes a row only while it holds what was listed, and Open leaves the key', async () => {
    const world = createWorld({ seed: 4 })
    const storage = new MemoryStorage()
    // An earlier visit's journal while storage is unavailable, in the page's localStorage.
    const earlier = await openJournalPage(
        world,
        'earlier',
        storage,
        {},
        { flags: { noStorage: true } },
    )
    const a = stateOf(goldenChart())
    const session = beginSession(earlier, a, 'new')
    append(earlier, 'edit', 'Edit', widen(a))
    assert.equal(earlier.writer.write(), true)
    earlier.tab.kill()
    const journalKey = `journal.${session.id}`
    const text = storage.getItem(`nse.${journalKey}`)
    assert.ok(text)
    local.setItem(storageKey(journalKey), text)
    const slot = autoSaveText(widen(a, 2))
    local.setItem(storageKey(AUTO_SAVE_KEY), slot)
    local.setItem(storageKey(LEGACY_RECOVERY_KEY), slot)

    const loaded = await load(world, 'tab', storage, { core: { flags: { noStorage: true } } })
    setSessionContext(loaded.deps, loaded.recovery)
    assert.equal(loaded.recovery.keptForLocalData.length, 1)
    const items = await recoveryItems()
    assert.deepEqual(
        items.map((item) => item.kind),
        ['journal', 'autoSave', 'legacy'],
    )
    const [journal, autoSave] = items
    assert.ok(journal?.kind === 'journal' && autoSave?.kind === 'autoSave')
    assert.equal(autoSave.readable, true)

    // Open: a new session in this tab, the keys staying.
    assert.equal(openRecoveryJournal(journal), true)
    assert.equal(openRecoveryAutoSave(autoSave), true)
    assert.equal(loaded.shownStates.length, 2)
    assert.equal(local.getItem(storageKey(journalKey)), text)
    assert.equal(local.getItem(storageKey(AUTO_SAVE_KEY)), slot)

    // Download: the file `gate.js` would offer.
    const file = await recoveryFile(autoSave)
    assert.ok(file)

    // Discard: a key changed since it was listed stays.
    local.setItem(storageKey(journalKey), `${text} `)
    await discardRecoveryItem(journal)
    assert.equal(local.getItem(storageKey(journalKey)), `${text} `)
    await discardRecoveryItem(autoSave)
    assert.equal(local.getItem(storageKey(AUTO_SAVE_KEY)), null)
})

test('Discard of unreadable recovered work removes only that row', async () => {
    const world = createWorld({ seed: 5 })
    const storage = new MemoryStorage()
    storage.setItem('nse.journal.a', '{"damaged":')
    storage.setItem('nse.journal.b', 'not json')
    const loaded = await load(world, 'tab', storage)
    setSessionContext(loaded.deps, loaded.recovery)
    const recovered = (await recoveryItems()).filter((item) => item.kind === 'recovered')
    assert.equal(recovered.length, 2)
    const [one] = recovered
    assert.ok(one)
    assert.equal(typeof (await recoveryFile(one)), 'object')
    await loaded.page.tab.run(() => discardRecoveryItem(one))
    assert.equal((await recoveryItems()).filter((item) => item.kind === 'recovered').length, 1)
})

/** A session another tab had open, with edits only its journal holds, then the tab died. */
const pendingJournal = async (world: World, storage: MemoryStorage) => {
    const other = await openJournalPage(world, 'other', storage)
    const a = stateOf(goldenChart())
    const session = beginSession(other, a, 'import')
    await other.flusher.flush({ strict: true })
    append(other, 'edit', 'Only journalled', widen(a, 6))
    assert.equal(other.writer.write(), true)
    other.tab.kill()
    const text = storage.getItem(`nse.journal.${session.id}`)!
    const reading = readJournal(text, session.id)
    const content = reading.kind === 'journal' ? journalState(reading.journal) : undefined
    const root = content?.kind === 'state' ? rootOf(content.state) : ''
    return { session, root }
}

test('Reopen of a session whose journal fails to apply starts from the journal’s state, never the stale one', async () => {
    const world = createWorld({ seed: 6 })
    const storage = new MemoryStorage()
    const loaded = await load(world, 'tab', storage)
    const { session, root } = await pendingJournal(world, storage)
    setSessionContext(loaded.deps, {
        ...loaded.recovery,
        worker: {
            ...loaded.recovery.worker,
            applyJournal: () => Promise.reject(new Error('QuotaExceededError')),
        },
    })
    leftSession(session.id, { kind: 'date' }, 0, Promise.resolve(true))
    const result = await loaded.page.tab.run(() => reopenSession())
    assert.deepEqual(result, { opened: true })
    const reopened = openSession(loaded)
    assert.equal(reopened.parent?.id, session.id)
    assert.equal(reopened.forkOf, undefined)
    assert.equal(rootOf(loaded.page.live.state), root)
})

test('Reopen of a session whose journal a newer build wrote opens nothing, and says why', async () => {
    const world = createWorld({ seed: 7 })
    const storage = new MemoryStorage()
    const loaded = await load(world, 'tab', storage)
    const { session } = await pendingJournal(world, storage)
    const key = `nse.journal.${session.id}`
    storage.setItem(
        key,
        JSON.stringify({ ...JSON.parse(storage.getItem(key)!), journalVersion: 2 }),
    )
    setSessionContext(loaded.deps, loaded.recovery)
    leftSession(session.id, { kind: 'date' }, 0, Promise.resolve(true))
    const shown = rootOf(loaded.page.live.state)
    assert.deepEqual(await loaded.page.tab.run(() => restoreAsCopy(session.id)), false)
    assert.deepEqual(await loaded.page.tab.run(() => reopenSession()), {
        opened: false,
        why: 'later',
    })
    assert.equal(rootOf(loaded.page.live.state), shown)
})
