import type { FlushSession } from '../../../src/local/flush'
import { journalHandlers } from '../../../src/local/journal/handlers'
import { replayJournal, type ReplayDeps } from '../../../src/local/journal/replay'
import { MemoryStorage, storageJournalStore } from '../../../src/local/journal/store'
import { JournalWriter } from '../../../src/local/journal/writer'
import type { Tab, World } from '../../../src/local/testing/world'
import type { JournalStore } from '../../../src/platform/types'
import type { State } from '../../../src/state'
import { openPage, testId, workerCore, type Page } from '../flush/harness'

// A page with a journal writer over an in-memory localStorage, and a second tab that replays
// what it left, both on the test core.

export type JournalPage = Page & {
    storage: MemoryStorage
    store: JournalStore
    writer: JournalWriter
    /** The live state the writer journals: the head the test last appended. */
    live: { state: State }
}

export const openJournalPage = async (
    world: World,
    name: string,
    storage = new MemoryStorage(),
): Promise<JournalPage> => {
    const store = storageJournalStore(() => storage, 'nse.')
    const live = { state: undefined as unknown as State }
    const ref: { writer?: JournalWriter } = {}
    const page = await openPage(world, world.tab(name), {
        onCommitted: (session, { seq, strict }) => ref.writer?.committed(session.id, seq, strict),
        syncStrict: async () => {
            await page.tab.run(() =>
                journalHandlers({
                    core: page.core,
                    test: true,
                    emit: () => undefined,
                }).syncStrict(undefined),
            )
        },
    })
    const writer = new JournalWriter({
        store,
        flusher: () => page.flusher,
        state: () => live.state,
        pausedForSpace: () => page.core.status.reason === 'full',
        appVersion: '0.6.0',
        now: () => 1_792_130_467_000,
    })
    ref.writer = writer
    return { ...page, storage, store, writer, live }
}

/** Starts a session whose head the writer journals. */
export const beginSession = (
    page: JournalPage,
    state: State,
    origin: 'new' | 'import' = 'import',
): FlushSession => {
    page.live.state = state
    return page.flusher.begin({
        id: testId(),
        docId: testId(),
        origin,
        state,
        label: () => 'Initialize',
        dirty: false,
    })
}

/** Appends an entry as the undo stack would, the state becoming the live one. */
export const append = (
    page: JournalPage,
    kind: 'edit' | 'undo' | 'redo',
    label: string,
    state: State,
) => {
    page.live.state = state
    page.flusher.append(kind, () => label, state, true)
}

/** A second tab's replay of every pending journal in `storage`. */
export const replayAll = (world: World, storage: MemoryStorage, name = 'next') =>
    replayIn(world, world.tab(name), storage)

/** Replay in a given tab: a crash sweep's victim. */
export const replayIn = async (world: World, tab: Tab, storage: MemoryStorage) => {
    const core = workerCore(world, tab)
    await tab.run(() => core.start())
    const handlers = journalHandlers({ core, test: true, emit: () => undefined }, tab.waiter)
    const store = storageJournalStore(() => storage, 'nse.')
    const deps: ReplayDeps = {
        store,
        locks: tab.locks,
        appVersion: '0.6.0',
        label: (dropped) =>
            dropped
                ? `Recovered last change. ${dropped} undo step${dropped === 1 ? ' was' : 's were'} not kept.`
                : 'Recovered last change',
        newId: testId,
        now: () => 1_792_130_500_000,
        worker: {
            applyJournal: (batch) => tab.run(() => handlers.applyJournal(batch)),
            keepRecovered: (item) => tab.run(() => handlers.keepRecovered(item)),
        },
    }
    const outcomes = []
    for (const found of await store.read())
        outcomes.push(await tab.run(() => replayJournal(found, deps)))
    return { tab, core, store, outcomes }
}
