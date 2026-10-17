import type { Flusher, FlushSession } from '../../../src/local/flush'
import { journalHandlers } from '../../../src/local/journal/handlers'
import { replayJournal, type ReplayDeps } from '../../../src/local/journal/replay'
import { MemoryStorage, storageJournalStore } from '../../../src/local/journal/store'
import { JournalWriter, type JournalWriterDeps } from '../../../src/local/journal/writer'
import type { Tab, World } from '../../../src/local/testing/world'
import type { JournalStore } from '../../../src/platform/types'
import type { State } from '../../../src/state'
import {
    openPage,
    openSplitPage,
    testId,
    workerCore,
    type Page,
    type SplitPage,
    type WorkerHost,
    type WorkerSetup,
} from '../flush/harness'

// A page with a journal writer over an in-memory localStorage, and a second tab that replays
// what it left, both on the test core.

/** What the helpers below need of a page: its flusher and the live state. */
type Live = { flusher: Flusher; live: { state: State } }

type Journalled = {
    storage: MemoryStorage
    store: JournalStore
    writer: JournalWriter
    /** The live state the writer journals: the head the test last appended. */
    live: { state: State }
    /** How many strict syncs from now on fail, as a disk or a paused store would. */
    sync: { fails: number }
}

export type JournalPage = Page & Journalled

export type SplitJournalPage = SplitPage & Journalled

/** A writer over `storage`, wired to a flusher as `storing.ts` wires it. */
const journalled = (
    storage: MemoryStorage,
    flusher: () => Flusher | undefined,
    paused: () => boolean,
    extra: Partial<JournalWriterDeps> = {},
) => {
    const store = storageJournalStore(() => storage, 'nse.')
    const live = { state: undefined as unknown as State }
    const writer = new JournalWriter({
        store,
        flusher,
        state: () => live.state,
        pausedForSpace: paused,
        appVersion: '0.6.0',
        now: () => 1_792_130_467_000,
        ...extra,
    })
    return { storage, store, writer, live, sync: { fails: 0 } }
}

/** A sync that fails while the test says so. */
const failing = (sync: { fails: number }) => {
    if (sync.fails <= 0) return
    sync.fails--
    throw new Error('The strict sync failed')
}

export const openJournalPage = async (
    world: World,
    name: string,
    storage = new MemoryStorage(),
    writer: Partial<JournalWriterDeps> = {},
): Promise<JournalPage> => {
    const ref: { writer?: JournalWriter; sync?: { fails: number } } = {}
    const page = await openPage(world, world.tab(name), {
        onCommitted: (session, { seq, strict }) => ref.writer?.committed(session.id, seq, strict),
        onFork: (fork, from) => ref.writer?.forked(from, fork),
        syncStrict: () => {
            if (ref.sync) failing(ref.sync)
            return page.tab.run(() =>
                journalHandlers({
                    core: page.core,
                    test: true,
                    emit: () => undefined,
                }).syncStrict(undefined),
            )
        },
    })
    const parts = journalled(
        storage,
        () => page.flusher,
        () => page.core.status.reason === 'full',
        writer,
    )
    ref.writer = parts.writer
    ref.sync = parts.sync
    return { ...page, ...parts }
}

/** A split page (its worker on an actor of its own, with restarts) with a journal writer. */
export const openSplitJournalPage = async (
    world: World,
    setup: WorkerSetup & { name?: string } = {},
    storage = new MemoryStorage(),
): Promise<SplitJournalPage> => {
    const ref: { host?: WorkerHost; writer?: JournalWriter; sync?: { fails: number } } = {}
    const page = await openSplitPage(world, {
        ...setup,
        flush: {
            onCommitted: (session, { seq, strict }) =>
                ref.writer?.committed(session.id, seq, strict),
            onFork: (fork, from) => ref.writer?.forked(from, fork),
            syncStrict: async () => {
                if (ref.sync) failing(ref.sync)
                return (
                    (await ref.host?.call((_, core) =>
                        journalHandlers({ core, test: true, emit: () => undefined }).syncStrict(
                            undefined,
                        ),
                    )) ?? false
                )
            },
        },
    })
    ref.host = page.host
    const parts = journalled(
        storage,
        () => page.flusher,
        () => page.host.core.status.reason === 'full',
    )
    ref.writer = parts.writer
    ref.sync = parts.sync
    return { ...page, ...parts }
}

/** Starts a session whose head the writer journals. */
export const beginSession = (
    page: Live,
    state: State,
    origin: 'new' | 'import' = 'import',
    extra: { id?: string; done?: () => void } = {},
): FlushSession => {
    page.live.state = state
    return page.flusher.begin({
        id: extra.id ?? testId(),
        docId: testId(),
        origin,
        state,
        label: () => 'Initialize',
        dirty: false,
        ...(extra.done ? { done: extra.done } : {}),
    })
}

/** Appends an entry as the undo stack would, the state becoming the live one. */
export const append = (page: Live, kind: 'edit' | 'undo' | 'redo', label: string, state: State) => {
    page.live.state = state
    page.flusher.append(kind, () => label, state, true)
}

/** A second tab's replay of every pending journal in `storage`. */
export const replayAll = (world: World, storage: MemoryStorage, name = 'next') =>
    replayIn(world, world.tab(name), storage)

/** Replay in a given tab: a crash sweep's victim. */
export const replayIn = async (
    world: World,
    tab: Tab,
    storage: MemoryStorage,
    deps: Partial<ReplayDeps> = {},
) => {
    const core = workerCore(world, tab)
    await tab.run(() => core.start())
    const handlers = journalHandlers({ core, test: true, emit: () => undefined }, tab.waiter)
    const store = storageJournalStore(() => storage, 'nse.')
    const replayDeps: ReplayDeps = {
        store,
        locks: tab.locks,
        appVersion: '0.6.0',
        label: (dropped) =>
            dropped
                ? `Recovered last change. ${dropped} undo step${dropped === 1 ? ' was' : 's were'} not kept.`
                : 'Recovered last change',
        now: () => 1_792_130_500_000,
        worker: {
            applyJournal: (batch) => tab.run(() => handlers.applyJournal(batch)),
            keepRecovered: (item) => tab.run(() => handlers.keepRecovered(item)),
        },
        ...deps,
    }
    const outcomes = []
    for (const found of await store.read())
        outcomes.push(await tab.run(() => replayJournal(found, replayDeps)))
    return { tab, core, store, outcomes }
}
