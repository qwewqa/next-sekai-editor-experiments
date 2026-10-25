import type { JournalStore, LockService } from '../platform/types'
import { broadcastChannel } from './channel'
import type { CleanupResult } from './cleanup'
import { createDeletion, runGc, setDeletion, type DeletionDeps, type SweepResult } from './deletion'
import { hasWebLocks, realTimers, type Timers } from './locks'
import { relieveAtLoad, relieveFull, type PressureDeps, type PressureRun } from './pressure'
import { retryStoring } from './retryStoring'
import type { ReadWorker } from './storedRead'
import type { StorageStatus } from './worker/core'

// The maintenance runner: when the deleting jobs run. One run at a time,
// in order: reclaim what deleted chains left outside storage, sweep chains marked for Delete long
// enough ago, GC, cleanup under pressure (at load when usage is high, and after storing paused for
// a full browser), and at load `persist()`. A trigger during a run queues one more run.
// Jobs start only while the page is visible (the load's too); one already running when it hides runs
// to its end. A page hidden at load still asks for `persist()`.

/** Becoming visible triggers a run at most this often. */
const VISIBLE_EVERY_MS = 60_000

/** A run that found `nse-maint` held tries again this much later, while visible. */
const BUSY_RETRY_MS = 30_000

/** Cleanup reads every chain's head and media row in one transaction: past the usual timeout. */
const CLEANUP_TIMEOUT_MS = 60_000

export type RunnerDeps = {
    worker: ReadWorker
    /** Delete's sweep (`sweepDeleted`). */
    sweep: () => Promise<SweepResult>
    /** Removes markers and kept bytes of deleted chains. */
    reclaim: () => Promise<void>
    /** Asks the browser to keep this origin's data: fire and forget, never awaited. */
    persist?: () => unknown
    /** Cleanup under pressure: at load, and after storing paused for a full browser. */
    pressure?: {
        atLoad: () => Promise<PressureRun | undefined>
        whenFull: () => Promise<PressureRun>
    }
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
        try {
            void Promise.resolve(deps.persist?.()).catch(() => undefined)
        } catch {
            // Refused at once: everything works without it.
        }
    }

    /** The pressure checks still owed: the load's, and one after storing paused full. */
    const owedPressure = { load: false, full: false }

    /** The owed pressure checks; true when one was busy and is owed again. */
    const relieve = async () => {
        const { pressure } = deps
        if (!pressure) return false
        let busy = false
        if (owedPressure.load) {
            owedPressure.load = false
            if ((await pressure.atLoad())?.busy) busy = owedPressure.load = true
        }
        if (owedPressure.full) {
            owedPressure.full = false
            if ((await pressure.whenFull()).busy) busy = owedPressure.full = true
        }
        return busy
    }

    const runOnce = async (load: boolean) => {
        await deps.reclaim().catch(() => undefined)
        const swept = await deps.sweep()
        // Due after a removal through `deletionsPending`; a busy or aborted pass is retried.
        const gc = await runGc(deps.worker, false)
        if (load) owedPressure.load = true
        const pressed = await relieve().catch(() => false)
        if (swept.busy || gc?.kind === 'busy' || gc?.kind === 'aborted' || pressed) retryLater()
        if (load) askPersist()
    }

    /** Runs the steps, or queues one more run behind the one running. */
    const trigger = (load = false): Promise<void> => {
        const hidden = !deps.visible()
        // A load that can't run now keeps its pressure check for the next run.
        if (load && (hidden || running)) {
            owedPressure.load = true
            askPersist()
        }
        if (hidden) {
            owed = true
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
        /** The load's run, at idle after startup; `full` when storing is paused full already. */
        start: (full = false) => {
            if (full) owedPressure.full = true
            return trigger(true)
        },
        /** The page became visible. */
        visible: () => {
            const at = now()
            if (!owed && at - lastVisible < VISIBLE_EVERY_MS) return Promise.resolve()
            owed = false
            lastVisible = at
            return trigger()
        },
        /** Storing paused for a full browser: a run with cleanup rounds and Try Again. */
        full: () => {
            owedPressure.full = true
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

/**
 * `persist()` wherever the browser has it, Firefox included, whose prompt is acceptable.
 * Best effort: a refusal, a rejection or `false` changes nothing.
 */
export const persistStorage = (storage: Partial<StorageManager> | undefined) =>
    typeof storage?.persist === 'function' ? storage.persist() : undefined

/** Updates lists in every tab, this one's included (another channel object hears it). */
const updated = () => {
    const channel = broadcastChannel()
    channel.post({ type: 'sessionUpdated' })
    channel.close()
}

/** The page's worker as the runner follows it: its calls and its status. */
export type MaintenanceWorker = ReadWorker & {
    readonly status: StorageStatus | undefined
    onStatus: (listener: (status: StorageStatus) => void) => unknown
}

export type MaintenanceDeps = {
    worker: MaintenanceWorker
    locks: LockService
    journal: JournalStore
    replayJournal: DeletionDeps['replayJournal']
    reclaim: () => Promise<void>
}

const pausedFull = (status: StorageStatus | undefined) =>
    status?.mode === 'stored' && status.reason === 'full'

/**
 * Sets up this tab's Delete and its runner (a stored, non-safe tab); `start` is the load's run at
 * idle. Returns the deletion for the test hooks.
 */
export const startMaintenance = (deps: MaintenanceDeps) => {
    const { worker } = deps
    const pressure: PressureDeps = {
        removeCachedMedia: (bytes) =>
            worker.call('removeCachedMedia', { bytes } as never, {
                timeoutMs: CLEANUP_TIMEOUT_MS,
            }) as Promise<CleanupResult>,
        estimate: async () => navigator.storage.estimate(),
        paused: () => (worker.status?.mode === 'stored' ? worker.status.reason : undefined),
        retryStoring,
    }
    const runner = createRunner({
        worker,
        sweep: () => deletion.sweepDeleted(),
        reclaim: deps.reclaim,
        persist: () => persistStorage(navigator.storage),
        pressure: {
            atLoad: () => relieveAtLoad(pressure),
            whenFull: () => relieveFull(pressure),
        },
        visible: () => document.visibilityState === 'visible',
        timers: realTimers,
        now: Date.now,
    })
    const deletion = createDeletion({
        worker,
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
    // Storing turning paused for a full browser: a cleanup round, then Try Again.
    const fullAtSetup = pausedFull(worker.status)
    let wasFull = fullAtSetup
    worker.onStatus((status) => {
        const full = pausedFull(status)
        if (full && !wasFull) void runner.full()
        wasFull = full
    })
    return { deletion, start: () => runner.start(fullAtSetup) }
}
