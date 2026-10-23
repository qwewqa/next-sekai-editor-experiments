import { detection } from '../platform/detect'
import type { JournalStore, LockService } from '../platform/types'
import { broadcastChannel } from './channel'
import { createDeletion, runGc, setDeletion, type DeletionDeps, type SweepResult } from './deletion'
import { hasWebLocks, realTimers, type Timers } from './locks'
import type { ReadWorker } from './storedRead'

// The maintenance runner (deletion design §3.10): when the deleting jobs run. One run at a time,
// in order: reclaim what deleted chains left outside storage, sweep chains marked for Delete long
// enough ago, GC, and at load a silent `persist()`. A trigger during a run queues one more run.
// Jobs start only while the page is visible (the load's too); one already running when it hides runs
// to its end. A page hidden at load still asks for `persist()`.

/** Becoming visible triggers a run at most this often. */
const VISIBLE_EVERY_MS = 60_000

/** A run that found `nse-maint` held tries again this much later, while visible. */
const BUSY_RETRY_MS = 30_000

export type RunnerDeps = {
    worker: ReadWorker
    /** Delete's sweep (`sweepDeleted`). */
    sweep: () => Promise<SweepResult>
    /** Removes markers, revocations and kept bytes of deleted chains. */
    reclaim: () => Promise<void>
    /** Asks the browser to keep this origin's data: fire and forget, never awaited. */
    persist?: () => unknown
    visible: () => boolean
    timers: Timers
    now: () => number
}

export const createRunner = (deps: RunnerDeps) => {
    const { timers, now } = deps
    let running: Promise<void> | undefined
    /** A trigger came during a run: one more run follows it. */
    const queued = { again: false }
    const wanted = () => queued.again
    let lastVisible = -Infinity
    /** A run was wanted while hidden: the next visibility runs without waiting a minute. */
    let owed = false
    /** Wall times a Delete's sweep is due at, soonest first, with the timer for the first. */
    const due: number[] = []
    let dueTimer: unknown
    let retryTimer: unknown

    const retryLater = () => {
        if (retryTimer !== undefined) return
        retryTimer = timers.setTimeout(() => {
            retryTimer = undefined
            void trigger()
        }, BUSY_RETRY_MS)
    }

    let persisted = false
    const askPersist = () => {
        if (persisted) return
        persisted = true
        void Promise.resolve(deps.persist?.()).catch(() => undefined)
    }

    const runOnce = async (load: boolean) => {
        await deps.reclaim().catch(() => undefined)
        const swept = await deps.sweep()
        // Due after a removal through `deletionsPending`; a busy or aborted pass is retried.
        const gc = await runGc(deps.worker, false)
        if (swept.busy || gc?.kind === 'busy' || gc?.kind === 'aborted') retryLater()
        if (load) askPersist()
    }

    /** Runs the steps, or queues one more run behind the one running. */
    const trigger = (load = false): Promise<void> => {
        if (!deps.visible()) {
            owed = true
            if (load) askPersist()
            return Promise.resolve()
        }
        if (running) {
            queued.again = true
            return running
        }
        running = (async () => {
            let first = load
            do {
                queued.again = false
                await runOnce(first).catch(() => undefined)
                first = false
            } while (wanted() && deps.visible())
        })().finally(() => {
            running = undefined
        })
        return running
    }

    const armDue = () => {
        if (dueTimer !== undefined) timers.clearTimeout(dueTimer)
        dueTimer = undefined
        const next = due[0]
        if (next === undefined) return
        dueTimer = timers.setTimeout(
            () => {
                dueTimer = undefined
                const at = now()
                while (due[0] !== undefined && due[0] <= at) due.shift()
                armDue()
                void trigger()
            },
            Math.max(0, next - now()),
        )
    }

    return {
        /** The load's run, at idle after startup. */
        start: () => trigger(true),
        /** The page became visible. */
        visible: () => {
            const at = now()
            if (!owed && at - lastVisible < VISIBLE_EVERY_MS) return Promise.resolve()
            owed = false
            lastVisible = at
            return trigger()
        },
        /** A Delete's sweep falls due at this wall time. */
        sweepAt: (at: number) => {
            due.push(at)
            due.sort((a, b) => a - b)
            armDue()
        },
        trigger,
    }
}

/** `persist()` on Chromium and WebKit only: Firefox would ask the user (§3.8). */
const persist = () => {
    const { engine } = detection()
    if (engine !== 'chromium' && engine !== 'webkit') return
    return navigator.storage.persist()
}

/** Updates lists in every tab, this one's included (another channel object hears it). */
const updated = () => {
    const channel = broadcastChannel()
    channel.post({ type: 'sessionUpdated' })
    channel.close()
}

export type MaintenanceDeps = {
    worker: ReadWorker
    locks: LockService
    journal: JournalStore
    replayJournal: DeletionDeps['replayJournal']
    reclaim: () => Promise<void>
}

/**
 * Sets up this tab's Delete and its runner (a stored, non-safe tab); `start` is the load's run at
 * idle. Returns the deletion for the test hooks.
 */
export const startMaintenance = (deps: MaintenanceDeps) => {
    const runner = createRunner({
        worker: deps.worker,
        sweep: () => deletion.sweepDeleted(),
        reclaim: deps.reclaim,
        persist,
        visible: () => document.visibilityState === 'visible',
        timers: realTimers,
        now: Date.now,
    })
    const deletion = createDeletion({
        worker: deps.worker,
        locks: deps.locks,
        journal: deps.journal,
        replayJournal: deps.replayJournal,
        updated,
        sweepAt: (at) => {
            runner.sweepAt(at)
        },
    })
    // Without Web Locks nothing can be locked: Delete reports failed, and no job runs.
    if (!hasWebLocks()) return { deletion, start: () => Promise.resolve() }
    setDeletion(deletion)
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void runner.visible()
    })
    return { deletion, start: () => runner.start() }
}
