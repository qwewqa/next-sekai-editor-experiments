import { settleHeldBgm, type HeldEnvironment } from '../../../src/editor/media/heldBgm'
import { createSessionDescriptor, session } from '../../../src/history/session'
import { resetStates, restoreStates } from '../../../src/history/stack'
import type { FlushSession } from '../../../src/local/flush'
import { readHandleRow, type HandleRole } from '../../../src/local/handleRows'
import { journalHandlers } from '../../../src/local/journal/handlers'
import type { MemoryStorage } from '../../../src/local/journal/store'
import { TabClient } from '../../../src/local/sessions'
import type { LoadEvent } from '../../../src/local/startup/events'
import {
    claimTab,
    openAtStart,
    type Claim,
    type OpenDeps,
    type Shown,
} from '../../../src/local/startup/open'
import { runRecovery, type RecoveryContext } from '../../../src/local/startup/steps'
import type { World } from '../../../src/local/testing/world'
import type { CoreDeps } from '../../../src/local/worker/core'
import { flushHandlers } from '../../../src/local/worker/flushHandlers'
import { startupHandlers } from '../../../src/local/worker/startupHandlers'
import type { State } from '../../../src/state'
import { storageKey } from '../../../src/storage'
import { initialStep, nativeOperation, originOperation } from '../../helpers/historySteps'
import { testId } from '../flush/harness'
import { beginSession, openJournalPage, type JournalPage } from '../journal/harness'
import { goldenChart, stateOf } from '../records/charts'
import { watchMedia } from './mediaRead'

// A whole load on the test core, as `start.ts` runs it: the tab's claim, the recovery order over
// the page's journal store, the page's own blank start, then `openAtStart`. The tab's
// sessionStorage is Node's, and the editor side (`show.ts`) records what it was shown.

/** A tab's sessionStorage as the next load of that tab finds it. */
export type TabStorage = Map<string, string>

/** Puts a tab's sessionStorage in place (Node has one per process), and returns it after. */
const useTab = (tab: TabStorage) => {
    sessionStorage.clear()
    for (const [key, value] of tab) sessionStorage.setItem(key, value)
}

const saveTab = (tab: TabStorage) => {
    tab.clear()
    for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i)
        if (key !== null) tab.set(key, sessionStorage.getItem(key) ?? '')
    }
}

/** The marker a page going away writes. */
export const markUnloaded = (tab: TabStorage, sessionId: string) => {
    tab.set(storageKey('unloaded'), sessionId)
}

/** The tab record as this tab's next load reads it. */
export const tabRecord = (tab: TabStorage) => {
    const text = tab.get(storageKey('tab'))
    return text === undefined ? undefined : (JSON.parse(text) as Record<string, unknown>)
}

export type LoadOptions = {
    /** The tab's sessionStorage; a new tab when absent. */
    tab?: TabStorage
    core?: Partial<CoreDeps>
    /** Replaces worker methods (an apply that fails, say). */
    worker?: Partial<RecoveryContext['worker']>
    /** Wraps the page's worker calls for `openAtStart`, as a test shim. */
    call?: (name: string, result: unknown) => unknown
    /** Runs between the blank start and the open: an edit made meanwhile, say. */
    meanwhile?: (page: JournalPage) => void
    appVersion?: string
    /** While `on`, the page's flushes never reach the worker, as a stalled store's. */
    stall?: { on: boolean }
    /** The page's media reads, as the live watcher makes them (one that fails, say). */
    media?: Partial<HeldEnvironment>
    /** Runs before the editor side shows a session (one that throws, say). */
    show?: (shown: Shown) => void
}

export type Load = Awaited<ReturnType<typeof load>>

/** One load of a tab over the profile's localStorage `storage`. */
export const load = async (
    world: World,
    name: string,
    storage: MemoryStorage,
    options: LoadOptions = {},
) => {
    const tab = options.tab ?? new Map<string, string>()
    useTab(tab)
    const page = await openJournalPage(world, name, storage, {}, options.core ?? {})
    const stall = options.stall
    if (stall) {
        const own = page.flusher as unknown as {
            deps: { transport: (...args: never[]) => unknown }
        }
        const transport = own.deps.transport
        own.deps.transport = async (...args) => {
            while (stall.on) await new Promise((resolve) => setTimeout(resolve, 5))
            return transport(...args)
        }
    }
    const claim: Claim = await page.tab.run(() => claimTab(page.tab.locks))
    const context = { core: page.core, test: true, emit: () => undefined }
    const journal = journalHandlers(context, page.tab.waiter)
    const startup = startupHandlers(context, page.tab.waiter)
    const flush = flushHandlers(context, page.tab.waiter)
    const events: LoadEvent[] = []
    const recovery: RecoveryContext = {
        worker: {
            applyJournal: (batch) => page.tab.run(() => journal.applyJournal(batch)),
            keepRecovered: (item) => page.tab.run(() => journal.keepRecovered(item)),
            readMetaIds: () => page.tab.run(() => startup.readMetaIds()),
            migratedBefore: (hash) => page.tab.run(() => startup.migratedBefore(hash)),
            migrateAutoSave: (batch) => page.tab.run(() => startup.migrateAutoSave(batch)),
            ...options.worker,
        },
        status: page.core.status,
        locks: page.tab.locks,
        journal: page.store,
        storage: () => storage,
        prefix: 'nse.',
        appVersion: options.appVersion ?? '0.6.0',
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
        now: () => 1_792_130_500_000,
        ...(claim.kind === 'reload' ? { own: claim.record.sessionId } : {}),
        outcomes: [],
        keptForLocalData: [],
        events: (event) => events.push(event),
    }
    await runRecovery(recovery)
    // The page's own blank start, as the first reset begins it.
    const blankState = stateOf(goldenChart())
    const blank = beginSession(page, blankState, 'new')
    session.value = createSessionDescriptor({ sessionId: blank.id, docId: blank.docId })
    resetStates({ state: blankState, step: initialStep(), isDirty: false })
    options.meanwhile?.(page)
    // The core's own `readHandle`, as `handlers.ts` has it.
    const readHandle = ({ chainId, role }: { chainId: string; role: HandleRole }) =>
        page.core.read(['chains', 'handles'], (tx) => readHandleRow(tx, chainId, role))
    const handlers = { ...flush, ...startup, ...journal, readHandle } as unknown as Record<
        string,
        (arg: unknown) => Promise<unknown>
    >
    const shown: Shown[] = []
    const shownStates: State[] = []
    const own = recovery.ownOutcome
    const deps: OpenDeps = {
        worker: {
            call: (async (method: string, arg: unknown) => {
                const result = await page.tab.run(() => handlers[method]!(arg))
                return options.call ? options.call(method, result) : result
            }) as OpenDeps['worker']['call'],
        },
        status: page.core.status,
        locks: page.tab.locks,
        client: new TabClient(page.tab.locks),
        safe: false,
        journal: page.store,
        ...(recovery.migrated ? { migrated: recovery.migrated } : {}),
        ...(recovery.ownJournal ? { ownJournal: recovery.ownJournal } : {}),
        ...(recovery.ownLeft ? { ownLeft: true } : {}),
        ...(recovery.ownFailed ? { ownFailed: true } : {}),
        ...(own && 'result' in own && own.result.kind === 'recovery'
            ? { ownRecovery: own.result.sessionId }
            : {}),
        keptForLocalData: recovery.keptForLocalData,
        retireJournal: (found, by, seq, dropped) => page.writer.retire(found, by, seq, dropped),
        flusher: () => page.flusher,
        show: (each) => {
            options.show?.(each)
            shown.push(each)
            session.value = each.descriptor
            restoreStates(each.slots, each.at, each.state, each.earlier)
            page.live.state = each.state
            each.installed?.()
        },
        // As `openState` does: a new session begins with it.
        showState: (state) => {
            shownStates.push(state)
            beginSession(page, state, 'import')
        },
        untouched: () => {
            const session = page.flusher.session
            return session === blank && !session.stored && session.pending.length <= 1
        },
        newId: testId,
        operations: {
            continued: (fromTime) =>
                nativeOperation({ id: 'nse.continue', data: { fromTime } }, 'Continued'),
            recovered: (droppedSteps) =>
                nativeOperation(
                    { id: 'nse.recovery', data: { droppedSteps } },
                    'Recovered last change',
                ),
        },
        events: (event) => events.push(event),
    }
    // The page reads the media store for a BGM the state names without audio.
    watchMedia(context, (work) => page.tab.run(work), options.media)
    const opened = await page.tab.run(() => openAtStart(deps, claim))
    await settleHeldBgm()
    saveTab(tab)
    return { page, tab, claim, recovery, deps, events, opened, shown, shownStates, blank }
}

/** The session open in a load's page. */
export const openSession = (loaded: Load): FlushSession => {
    const session = loaded.page.flusher.session
    if (!session) throw new Error('No session is open')
    return session
}

/** Writes the tab record as the page that had this session would have. */
export const recordTab = (tab: TabStorage, record: Record<string, unknown>) => {
    tab.set(storageKey('tab'), JSON.stringify(record))
}
