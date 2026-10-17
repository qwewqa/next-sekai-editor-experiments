import { getVerticalScale } from '../editor/navigation'
import { view } from '../editor/view'
import { onHistoryAction } from '../history/actions'
import { session as currentSession } from '../history/session'
import { liveState, setSlotLoader } from '../history/stack'
import { appVersion, platform } from '../platform'
import { isDurablyStoredWith } from './durable'
import { Flusher, flushTimeoutMs, heldMediaOf, mediaTimeoutMs, type FlushReport } from './flush'
import { toHex } from './hash'
import { JournalWriter, type JournalWrite } from './journal/writer'
import { inspectSnapshot } from './records/inspect'
import { stateFromRecords } from './records/records'
import { decodeSnapshot } from './records/snapshot'
import { holdSessionLock, TabClient } from './sessions'
import type { StorageWorker } from './worker/client'
import type { StorageStatus } from './worker/core'
import { transfer } from './worker/rpc'

// Storing alongside today's auto save (Part 1 §1.11.3: until Step 4 startup is today's, every load
// starts a new session and a new chain, and stored sessions aren't shown). Every change to the
// undo stack becomes an entry; the flush stores them about 1 s after the last change, at once and
// strictly on hide, and right after a media pick.

declare global {
    // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
    interface Window {
        /** The dev console's tools (§1.6.11.1's debug viewer). */
        nse?: { inspectSnapshot: (hash: string) => Promise<unknown> }
        /** The flusher for specs, when a storage test flag is seeded. */
        nseFlushTest?: {
            flusher: Flusher
            reports: FlushReport[]
            errors: unknown[]
            journal: { writer: JournalWriter; writes: JournalWrite[] }
            /** Set by a spec: flushes from now on never reach the worker. */
            stall?: boolean
            isDurablyStored: () => boolean
        }
    }
}

/** This tab's flusher, once storing started. */
export let flusher: Flusher | undefined

/** This tab's journal writer (§1.6.4 #7), once storing started. */
export let journalWriter: JournalWriter | undefined

let storingWorker: StorageWorker | undefined

/**
 * Whether leaving the open session can lose it (§1.6.7's predicate). The journal is written
 * first when it's due, as the leave and switch triggers do; its verification decides.
 */
export const isDurablyStored = () => {
    journalWriter?.write()
    return isDurablyStoredWith({
        status: storingWorker?.status,
        flusher,
        journal: journalWriter,
        media: heldMediaOf(liveState.value).map((item) => item.hash),
    })
}

let watching = false

/**
 * Flushes at once and strictly on hide and freeze (§1.6.4). Watched from startup, before the
 * worker answers, so the page's listeners are all in place early and never added later.
 */
export const watchLifecycle = () => {
    if (watching) return
    watching = true
    platform.onLifecycle((event) => {
        if (event !== 'hide' && event !== 'freeze') return
        // The journal first, synchronously: the flush may not finish before the page goes.
        journalWriter?.write()
        void flusher?.flush({ strict: true, oneGo: true })
    })
    // beforeunload too (§1.6.4 #7); it never keeps the page itself.
    platform.onCloseRequested(() => {
        journalWriter?.write()
        return true
    })
}

/** Waits while a spec holds flushes, to leave edits only the journal has, as a kill does. */
const whileStalled = async () => {
    while (window.nseFlushTest?.stall) await new Promise((resolve) => setTimeout(resolve, 50))
}

/**
 * Starts storing: entries from now on, and the journal on hide. `replayed` is the startup replay
 * of journals, which every flush waits for (§1.6.4 #7: before any session opens).
 */
export const startStoring = (
    worker: StorageWorker,
    status: StorageStatus,
    test: boolean,
    replayed: Promise<unknown> = Promise.resolve(),
) => {
    const afterReplay = replayed.catch(() => undefined)
    const reports: FlushReport[] = []
    const errors: unknown[] = []
    const locks = platform.locks
    // This tab's client id for query() (§1.6.5).
    const client = new TabClient(locks)
    void client.lock.granted.catch(() => undefined)

    if (status.mode === 'readOnly') {
        // A newer database: nothing is written. Earlier actions are let go.
        onHistoryAction(() => undefined, { replay: true })
        return
    }

    const writes: JournalWrite[] = []
    const instance = new Flusher({
        appVersion: appVersion().appVersion,
        // A strict commit clears the journal it covers (§1.6.4 #7).
        onCommitted: (session, { seq, strict }) => {
            journalWriter?.committed(session.id, seq, strict)
        },
        syncStrict: () => worker.call('syncStrict'),
        transport: (batch, list, current) =>
            // A spec holds flushes to leave edits only the journal has, as a kill does.
            (test ? whileStalled() : Promise.resolve()).then(() =>
                worker.call('flush', transfer(batch, list), {
                    timeoutMs: flushTimeoutMs(batch),
                    current,
                }),
            ),
        storeMedia: (item) =>
            worker.call('storeMedia', item, { timeoutMs: mediaTimeoutMs(item.bytes.byteLength) }),
        view: () => ({
            scroll: view.time,
            zoom: getVerticalScale(),
            ...(view.groupId === undefined ? {} : { group: view.groupId }),
            ...(view.stageId === undefined ? {} : { stage: view.stageId }),
        }),
        lockSession: (id) => {
            const lock = holdSessionLock(locks, id)
            return { ready: lock.granted.catch(() => undefined), done: lock.release }
        },
        onFork: (fork, from) => {
            journalWriter?.forked(from, fork)
            if (currentSession.value.sessionId === from.id)
                currentSession.value = {
                    ...currentSession.value,
                    sessionId: fork.id,
                    docId: fork.docId,
                }
        },
        onFlushed: (report) => {
            if (test) reports.push(report)
        },
        onError: (error) => {
            if (test) errors.push(error)
            // A dev build's checks (D9, a published state changed in place) fail loudly.
            if (import.meta.env.DEV) console.error('A flush failed', error)
        },
    })
    flusher = instance
    storingWorker = worker
    journalWriter = new JournalWriter({
        store: platform.journal,
        flusher: () => flusher,
        state: () => liveState.value,
        pausedForSpace: () => worker.status?.reason === 'full',
        strictCommits:
            typeof IDBTransaction !== 'undefined' && 'durability' in IDBTransaction.prototype,
        appVersion: appVersion().appVersion,
        onWrite: (write) => {
            if (test) writes.push(write)
        },
    })

    onHistoryAction(
        (action) => {
            if (action.kind === 'reset') {
                const descriptor = currentSession.value
                const lock = holdSessionLock(locks, descriptor.sessionId)
                instance.begin({
                    id: descriptor.sessionId,
                    docId: descriptor.docId,
                    origin: action.origin,
                    ...(descriptor.sourceName === undefined
                        ? {}
                        : { sourceName: descriptor.sourceName }),
                    state: action.state,
                    label: action.name,
                    dirty: action.isDirty,
                    // Without Web Locks (an insecure origin) there's no other tab to keep out.
                    ready: Promise.all([lock.granted.catch(() => undefined), afterReplay]),
                    done: lock.release,
                })
                return
            }
            instance.append(
                action.kind,
                action.name,
                action.state ?? action.snapshot,
                action.isDirty,
            )
        },
        { replay: true },
    )

    // A newer database opened by Try Again: nothing this tab holds will be stored.
    worker.onStatus((next) => {
        if (next.mode === 'readOnly') instance.withoutDatabase()
    })

    worker.onRestart(() => {
        void instance.restarted()
    })

    // A restored undo slot is built from its stored records when Undo or Redo reaches it.
    setSlotLoader(async (snapshot) => {
        const parts = await worker.call('readSnapshot', toHex(snapshot))
        const records = decodeSnapshot(parts.root, {
            node: (hex) => parts.nodes[hex],
            chunk: (hex) => parts.chunks[hex],
        })
        return stateFromRecords(records)
    })

    window.nse = {
        ...window.nse,
        inspectSnapshot: async (hash: string) => {
            const parts = await worker.call('readSnapshot', hash.toLowerCase())
            return inspectSnapshot(parts.root, {
                node: (hex) => parts.nodes[hex],
                chunk: (hex) => parts.chunks[hex],
            })
        },
    }
    if (test)
        window.nseFlushTest = {
            flusher: instance,
            reports,
            errors,
            journal: { writer: journalWriter, writes },
            isDurablyStored,
        }
    void worker.call('countDay').catch(() => undefined)
}
