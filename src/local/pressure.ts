import type { CleanupResult } from './cleanup'
import type { PauseReason, StorageStatus } from './worker/core'

// When cleanup under pressure runs (deletion design §3.7, DEL-D1 final), on the page: at load
// idle after GC when usage is high, and when storing pauses for a full browser. It removes only
// cached earlier media (`removeCachedMedia`); when that is not enough, storing stays paused with
// the usual signs and the user frees space by hand. One tab cleans at a time: the removal runs
// under `nse-maint` exclusive and is busy otherwise (R1).

/** Usage above this share of the quota cleans at load... */
export const HIGH_SHARE = 0.8
/** ...down to this share. */
export const LOW_SHARE = 0.7
/** A full browser's round frees at least this much: the disk may be full well below the quota. */
export const FULL_ROUND_BYTES = 64 * 1024 * 1024

export type Estimate = { usage?: number; quota?: number }

export type PressureDeps = {
    /** The worker's removal; rejects when the call failed. */
    removeCachedMedia: (bytes: number) => Promise<CleanupResult>
    estimate: () => Promise<Estimate>
    /** Why storing is paused now, if it is. */
    paused: () => PauseReason | undefined
    /** Try Again: the status after it. */
    retryStoring: () => Promise<StorageStatus | undefined>
}

export type PressureRun = {
    trigger: 'load' | 'full'
    /** Bytes removed in all, by the rows' sizes. */
    freed: number
    /** A removal found `nse-maint` held or an import running: try again later. */
    busy: boolean
}

/** The last runs, newest last, for the specs; a few at most. */
export const pressureRuns: PressureRun[] = []

const record = (run: PressureRun) => {
    pressureRuns.push(run)
    if (pressureRuns.length > 10) pressureRuns.shift()
    return run
}

const estimateOf = (deps: PressureDeps) => deps.estimate().catch((): Estimate => ({}))

/** The bytes above `share` of the quota; 0 when the estimate does not tell. */
const over = ({ usage, quota }: Estimate, share: number) =>
    usage !== undefined && quota !== undefined && quota > 0 ? usage - share * quota : 0

const round = (deps: PressureDeps, bytes: number) =>
    deps.removeCachedMedia(bytes).catch((): CleanupResult => ({ kind: 'busy' }))

/** At load idle, after GC: usage above 80% of the quota removes cached media down to 70%. */
export const relieveAtLoad = async (deps: PressureDeps): Promise<PressureRun | undefined> => {
    const estimate = await estimateOf(deps)
    if (over(estimate, HIGH_SHARE) <= 0) return
    const result = await round(deps, over(estimate, LOW_SHARE))
    return record({
        trigger: 'load',
        freed: result.kind === 'removed' ? result.bytes : 0,
        busy: result.kind === 'busy',
    })
}

/**
 * Storing paused for a full browser: one round of cached media, then Try Again, repeated while
 * storing is still paused full and the round removed something.
 */
export const relieveFull = async (deps: PressureDeps): Promise<PressureRun> => {
    let freed = 0
    while (deps.paused() === 'full') {
        const bytes = Math.max(FULL_ROUND_BYTES, over(await estimateOf(deps), LOW_SHARE))
        const result = await round(deps, bytes)
        if (result.kind === 'busy') return record({ trigger: 'full', freed, busy: true })
        if (result.kind !== 'removed' || !result.items) break
        freed += result.bytes
        await deps.retryStoring().catch(() => undefined)
    }
    return record({ trigger: 'full', freed, busy: false })
}
