import { getVerticalScale } from '../editor/navigation'
import { view } from '../editor/view'
import { onHistoryAction } from '../history/actions'
import { session as currentSession } from '../history/session'
import { appVersion, platform } from '../platform'
import { Flusher, flushTimeoutMs, mediaTimeoutMs, type FlushReport } from './flush'
import { inspectSnapshot } from './records/inspect'
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
        nseFlushTest?: { flusher: Flusher; reports: FlushReport[]; errors: unknown[] }
    }
}

/** This tab's flusher, once storing started. */
export let flusher: Flusher | undefined

let watching = false

/**
 * Flushes at once and strictly on hide and freeze (§1.6.4). Watched from startup, before the
 * worker answers, so the page's listeners are all in place early and never added later.
 */
export const watchLifecycle = () => {
    if (watching) return
    watching = true
    platform.onLifecycle((event) => {
        if (event === 'hide' || event === 'freeze')
            void flusher?.flush({ strict: true, oneGo: true })
    })
}

export const startStoring = (worker: StorageWorker, status: StorageStatus, test: boolean) => {
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

    const instance = new Flusher({
        appVersion: appVersion().appVersion,
        transport: (batch, list, current) =>
            worker.call('flush', transfer(batch, list), {
                timeoutMs: flushTimeoutMs(batch),
                current,
            }),
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
                    ready: lock.granted.catch(() => undefined),
                    done: lock.release,
                })
                return
            }
            instance.append(action.kind, action.name, action.state, action.isDirty)
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
    if (test) window.nseFlushTest = { flusher: instance, reports, errors }
    void worker.call('countDay').catch(() => undefined)
}
