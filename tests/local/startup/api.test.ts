import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { createSwitchRequest } from '../../../src/editor/switchRequest'
import { session as editorSession } from '../../../src/history/session'
import { liveState } from '../../../src/history/stack'
import type { FlushSession } from '../../../src/local/flush'
import { toHex } from '../../../src/local/hash'
import { journalState } from '../../../src/local/journal/content'
import { readJournal } from '../../../src/local/journal/format'
import { MemoryStorage } from '../../../src/local/journal/store'
import { toRecords } from '../../../src/local/records/records'
import { encodeSnapshot } from '../../../src/local/records/snapshot'
import { holdSessionLock } from '../../../src/local/sessions'
import {
    applyPendingJournal,
    discardRecoveryItem,
    leftSession,
    openRecoveryAutoSave,
    openRecoveryJournal,
    previousSession,
    recoveryFile,
    recoveryItems,
    reopenSession,
    restoreAsCopy,
    restoreSession,
    setSessionContext,
} from '../../../src/local/startup/api'
import { AUTO_SAVE_KEY } from '../../../src/local/startup/legacy'
import { readTabRecord } from '../../../src/local/startup/tab'
import { createWorld, type World } from '../../../src/local/testing/world'
import type { State } from '../../../src/state'
import { storageKey } from '../../../src/storage'
import { editStep, futureFixtureOperation, initialLife } from '../../helpers/historySteps'
import '../../helpers/lockChecks'
import { rows } from '../flush/harness'
import { append, beginSession, openJournalPage } from '../journal/harness'
import { goldenChart, stateOf } from '../records/charts'
import { widen } from '../timeline/helpers'
import { autoSaveText } from './autoSaveText'
import { readOpen } from './harness'
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
    append(page, { kind: 'edit', step: editStep(futureFixtureOperation('Edit')) }, widen(a))
    await page.flusher.flush({ strict: true })
    const replacing = beginSession(page, widen(a, 4), 'new')
    leftSession(left.id, { kind: 'date' }, 0, page.flusher.outgoing)
    const lefts: FlushSession[] = []
    setSessionContext({ ...loaded.deps, onLeft: (each) => lefts.push(each) }, loaded.recovery)

    const result = await page.tab.run(() => reopenSession())
    assert.deepEqual(result, { opened: true, forked: false })
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
    assert.deepEqual(await loaded.page.tab.run(() => restoreAsCopy(session.id)), {
        opened: true,
        forked: true,
    })
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
    append(earlier, { kind: 'edit', step: editStep(futureFixtureOperation('Edit')) }, widen(a))
    assert.equal(earlier.writer.write(), true)
    earlier.tab.kill()
    const journalKey = `journal.${session.id}`
    const text = storage.getItem(`nse.${journalKey}`)
    assert.ok(text)
    local.setItem(storageKey(journalKey), text)
    const slot = autoSaveText(widen(a, 2))
    local.setItem(storageKey(AUTO_SAVE_KEY), slot)

    const loaded = await load(world, 'tab', storage, { core: { flags: { noStorage: true } } })
    setSessionContext(loaded.deps, loaded.recovery)
    assert.equal(loaded.recovery.keptForLocalData.length, 1)
    const { items, unreadable } = await recoveryItems()
    assert.equal(unreadable, false)
    assert.deepEqual(
        items.map((item) => item.kind),
        ['journal', 'autoSave'],
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
    assert.ok(file.storedRead === 'value' && file.storedValue)

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
    const recovered = (await recoveryItems()).items.filter((item) => item.kind === 'recovered')
    assert.equal(recovered.length, 2)
    const [one] = recovered
    assert.ok(one)
    const row = await recoveryFile(one)
    assert.ok(row.storedRead === 'value' && row.storedValue)
    await loaded.page.tab.run(() => discardRecoveryItem(one))
    assert.equal(
        (await recoveryItems()).items.filter((item) => item.kind === 'recovered').length,
        1,
    )
})

test('a recovery listing that fails is reported as unreadable, never as nothing to recover', async () => {
    const world = createWorld({ seed: 5 })
    const storage = new MemoryStorage()
    storage.setItem('nse.journal.a', '{"damaged":')
    const loaded = await load(world, 'tab', storage)
    setSessionContext(loaded.deps, loaded.recovery)
    assert.deepEqual(
        await recoveryItems().then(({ items, unreadable }) => [items.length, unreadable]),
        [1, false],
    )
    const { worker } = loaded.deps
    setSessionContext(
        {
            ...loaded.deps,
            worker: {
                ...worker,
                call: (name: string, ...args: unknown[]) =>
                    name === 'listRecovered'
                        ? Promise.reject(new Error('the worker is down'))
                        : (worker.call as (name: string, ...args: unknown[]) => Promise<unknown>)(
                              name,
                              ...args,
                          ),
            } as typeof worker,
        },
        loaded.recovery,
    )
    const failed = await recoveryItems()
    assert.equal(failed.unreadable, true)
    assert.deepEqual(failed.items, [])
})

test('a recovered row’s download that fails is failed, and a row gone since it was listed is a value of none', async () => {
    const world = createWorld({ seed: 5 })
    const storage = new MemoryStorage()
    storage.setItem('nse.journal.a', '{"damaged":')
    const loaded = await load(world, 'tab', storage)
    setSessionContext(loaded.deps, loaded.recovery)
    const [row] = (await recoveryItems()).items.filter((item) => item.kind === 'recovered')
    assert.ok(row)
    const { worker } = loaded.deps
    const through = (fail: boolean) =>
        setSessionContext(
            {
                ...loaded.deps,
                worker: {
                    ...worker,
                    call: (name: string, ...args: unknown[]) =>
                        fail && name === 'readRecovered'
                            ? Promise.reject(new Error('the worker is down (recovery test)'))
                            : (
                                  worker.call as (
                                      name: string,
                                      ...args: unknown[]
                                  ) => Promise<unknown>
                              )(name, ...args),
                } as typeof worker,
            },
            loaded.recovery,
        )
    through(true)
    assert.equal((await recoveryFile(row)).storedRead, 'failed')
    through(false)
    await loaded.page.tab.run(() => discardRecoveryItem(row))
    assert.deepEqual(await recoveryFile(row), { storedRead: 'value', storedValue: undefined })
})

/** A session another tab had open, with edits only its journal holds, then the tab died. */
const pendingJournal = async (world: World, storage: MemoryStorage) => {
    const other = await openJournalPage(world, 'other', storage)
    const a = stateOf(goldenChart())
    const session = beginSession(other, a, 'import')
    await other.flusher.flush({ strict: true })
    append(
        other,
        { kind: 'edit', step: editStep(futureFixtureOperation('Only journalled')) },
        widen(a, 6),
    )
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
    assert.deepEqual(result, { opened: true, forked: false })
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
        JSON.stringify({ ...JSON.parse(storage.getItem(key)!), journalVersion: 3 }),
    )
    setSessionContext(loaded.deps, loaded.recovery)
    leftSession(session.id, { kind: 'date' }, 0, Promise.resolve(true))
    const shown = rootOf(loaded.page.live.state)
    assert.deepEqual(await loaded.page.tab.run(() => restoreAsCopy(session.id)), {
        opened: false,
        why: 'later',
    })
    assert.deepEqual(await loaded.page.tab.run(() => reopenSession()), {
        opened: false,
        why: 'later',
    })
    assert.equal(rootOf(loaded.page.live.state), shown)
})

test('Reopen over a failed journal a flush covered since takes up the stored session, and the key goes', async () => {
    const world = createWorld({ seed: 8 })
    const storage = new MemoryStorage()
    const loaded = await load(world, 'tab', storage)
    const other = await openJournalPage(world, 'other', storage)
    const a = stateOf(goldenChart())
    const session = beginSession(other, a, 'import')
    await other.flusher.flush({ strict: true })
    append(
        other,
        { kind: 'edit', step: editStep(futureFixtureOperation('Journalled')) },
        widen(a, 6),
    )
    assert.equal(other.writer.write(), true)
    append(
        other,
        { kind: 'edit', step: editStep(futureFixtureOperation('Stored past it')) },
        widen(a, 7),
    )
    await other.flusher.flush()
    const stored = toHex((await readOpen(other, session.id)).head)
    other.tab.kill()
    setSessionContext(loaded.deps, {
        ...loaded.recovery,
        worker: {
            ...loaded.recovery.worker,
            applyJournal: () => Promise.reject(new Error('QuotaExceededError')),
        },
    })
    leftSession(session.id, { kind: 'date' }, 0, Promise.resolve(true))
    assert.deepEqual(await loaded.page.tab.run(() => reopenSession()), {
        opened: true,
        forked: false,
    })
    assert.equal(rootOf(loaded.page.live.state), stored)
    assert.equal(storage.getItem(`nse.journal.${session.id}`), null)
})

test('applyPendingJournal applies a dead tab’s journal under the session’s lock, never while another tab holds it', async () => {
    const world = createWorld({ seed: 9 })
    const storage = new MemoryStorage()
    const loaded = await load(world, 'tab', storage)
    setSessionContext(loaded.deps, loaded.recovery)
    const dead = await openJournalPage(world, 'dead', storage)
    const a = stateOf(goldenChart())
    const lock = holdSessionLock(dead.tab.locks, 'pending')
    await dead.tab.run(() => lock.granted)
    const session = beginSession(dead, a, 'import', { id: 'pending' })
    await dead.flusher.flush({ strict: true })
    // Open in a live tab, which owns its journal.
    assert.equal(await loaded.page.tab.run(() => applyPendingJournal(session.id)), 'held')
    append(dead, { kind: 'edit', step: editStep(futureFixtureOperation('Edit')) }, widen(a))
    assert.equal(dead.writer.write(), true)
    dead.tab.kill()
    const outcome = await loaded.page.tab.run(() => applyPendingJournal(session.id))
    assert.equal(outcome !== 'held' && outcome?.kind, 'applied')
    const entries = [...rows(world, 'entries').values()].filter(
        (row) => row.sessionId === session.id,
    )
    assert.equal(entries.at(-1)?.kind, 'recovered')
    // Nothing pending any more.
    assert.equal(await loaded.page.tab.run(() => applyPendingJournal(session.id)), undefined)
})

for (const mode of ['newer-request', 'throw'] as const) {
    test(`installed Restore keeps destination and flusher coherent after a ${mode} hook`, async () => {
        const world = createWorld({ seed: 101 })
        const storage = new MemoryStorage()
        const loaded = await load(world, 'current', storage)
        const other = await openJournalPage(world, 'source', storage)
        const target = stateOf(goldenChart())
        const source = beginSession(other, target, 'import')
        await other.flusher.flush({ strict: true })
        other.tab.kill()
        let newer: ReturnType<typeof createSwitchRequest> | undefined
        let installedId: string | undefined
        let notices = 0
        setSessionContext(
            {
                ...loaded.deps,
                show: (shown) => {
                    loaded.deps.show(shown)
                    installedId = shown.descriptor.sessionId
                    assert.equal(loaded.page.flusher.session?.id, installedId)
                    assert.equal(editorSession.value.sessionId, installedId)
                    assert.equal(liveState.value, shown.state)
                    if (mode === 'throw') throw new Error('post-install hook')
                    newer = createSwitchRequest()
                },
                onLeft: () => {
                    notices++
                },
            },
            loaded.recovery,
        )
        try {
            const opening = loaded.page.tab.run(() => restoreAsCopy(source.id))
            if (mode === 'throw') await assert.rejects(opening, /post-install hook/)
            else assert.deepEqual(await opening, { opened: true, forked: true })
            assert.ok(installedId)
            assert.equal(editorSession.value.sessionId, installedId)
            assert.equal(loaded.page.flusher.session?.id, installedId)
            assert.equal(readTabRecord()?.sessionId, installedId)
            assert.equal(notices, 0)
            if (newer) assert.equal(newer.isCurrent(), true)
            // An untouched continuation is intentionally deferred until its first own entry.
            const head = loaded.page.live.state
            append(
                loaded.page,
                {
                    kind: 'edit',
                    step: editStep(initialLife(head.initialLife, head.initialLife + 1)),
                },
                { ...head, initialLife: head.initialLife + 1 },
            )
            await loaded.page.tab.run(() => loaded.page.flusher.flush({ strict: true }))
            assert.equal((await readOpen(loaded.page, installedId)).session.id, installedId)
        } finally {
            newer?.dispose()
            loaded.page.tab.kill()
        }
    })
}

test('Restore Session says whether it forked: not when it continues, yes when it is not the latest or is open elsewhere', async () => {
    const world = createWorld({ seed: 20 })
    const storage = new MemoryStorage()
    const other = await openJournalPage(world, 'other', storage)
    const a = stateOf(goldenChart())
    const first = beginSession(other, a, 'import')
    await other.flusher.flush({ strict: true })
    const loaded = await load(world, 'tab', storage)
    setSessionContext(loaded.deps, loaded.recovery)
    // Held by the other tab: a copy.
    assert.deepEqual(await loaded.page.tab.run(() => restoreSession(first.id)), {
        opened: true,
        forked: true,
    })
    assert.notEqual(openSession(loaded).forkOf, undefined)
    other.tab.kill()
    // Free and the chain's latest: the chain continues.
    const free = await load(world, 'free', storage)
    setSessionContext(free.deps, free.recovery)
    assert.deepEqual(await free.page.tab.run(() => restoreSession(first.id)), {
        opened: true,
        forked: false,
    })
    const continuation = openSession(free)
    assert.equal(continuation.forkOf, undefined)
    assert.equal(continuation.parent?.id, first.id)
    append(
        free.page,
        { kind: 'edit', step: editStep(futureFixtureOperation('Continued')) },
        widen(a, 1),
    )
    await free.page.tab.run(() => free.page.flusher.flush({ strict: true }))
    free.page.tab.kill()
    // The chain went on since: the first session is no longer its latest, so this is a copy.
    const later = await load(world, 'later', storage)
    setSessionContext(later.deps, later.recovery)
    assert.deepEqual(await later.page.tab.run(() => restoreSession(first.id)), {
        opened: true,
        forked: true,
    })
    assert.notEqual(openSession(later).forkOf, undefined)
})

test('Restore Session says why it opened nothing', async () => {
    const world = createWorld({ seed: 21 })
    const storage = new MemoryStorage()
    const loaded = await load(world, 'tab', storage)
    setSessionContext(loaded.deps, loaded.recovery)
    assert.deepEqual(await loaded.page.tab.run(() => restoreSession('nobody')), {
        opened: false,
        why: 'missing',
    })
    assert.deepEqual(await loaded.page.tab.run(() => restoreAsCopy('nobody')), {
        opened: false,
        why: 'missing',
    })
})

test('in safe mode a restore forks without replaying the journal and stores nothing', async () => {
    const world = createWorld({ seed: 22 })
    const storage = new MemoryStorage()
    const loaded = await load(world, 'tab', storage)
    const { session, root } = await pendingJournal(world, storage)
    const stores = ['sessions', 'chains', 'entries', 'stackBlocks', 'nodes', 'chunks', 'media']
    const dump = () => JSON.stringify(stores.map((store) => [...rows(world, store)]))
    const before = dump()
    const journal = storage.getItem(`nse.journal.${session.id}`)
    let replays = 0
    setSessionContext(
        { ...loaded.deps, safe: true },
        {
            ...loaded.recovery,
            worker: {
                ...loaded.recovery.worker,
                applyJournal: () => {
                    replays++
                    return Promise.reject(new Error('Safe mode writes nothing'))
                },
            },
        },
    )
    // Even Restore Session, which would continue a free session, opens a copy.
    assert.deepEqual(await loaded.page.tab.run(() => restoreSession(session.id)), {
        opened: true,
        forked: true,
    })
    const copy = openSession(loaded)
    assert.notEqual(copy.forkOf, undefined)
    assert.equal(copy.parent?.id, session.id)
    // The stored state, not the journal's: the journal stays for a normal load to apply.
    assert.notEqual(rootOf(loaded.page.live.state), root)
    assert.equal(replays, 0)
    assert.equal(storage.getItem(`nse.journal.${session.id}`), journal)
    assert.equal(dump(), before)
})
