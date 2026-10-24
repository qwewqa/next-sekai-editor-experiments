import type { Flusher } from './flush'
import type { StorageStatus } from './worker/core'

// Try Again for storing: the one retry behind the Not stored chip's dialog,
// Settings › Local Data and the cleanup after a full browser. The worker alone is not enough:
// asking it again reopens a dropped connection or a blocked upgrade, but nothing is written
// until the flusher sends its pending entries, which is what clears a pause.

/** Try Again waits about 3 s for other tabs, then moves what was stored in memory. */
const TRY_AGAIN_TIMEOUT_MS = 30_000

/** What the retry needs of the page's worker client. */
export type RetryWorker = {
    call: (
        method: 'tryAgain',
        arg: undefined,
        options: { timeoutMs: number },
    ) => Promise<StorageStatus>
    readonly status: StorageStatus | undefined
}

/** Asks the worker again, then flushes what is pending strictly; resolves with the status after. */
export const retryStoringWith = async (
    worker: RetryWorker,
    flusher: Pick<Flusher, 'flush'> | undefined,
): Promise<StorageStatus | undefined> => {
    try {
        await worker.call('tryAgain', undefined, { timeoutMs: TRY_AGAIN_TIMEOUT_MS })
    } catch {
        // A worker that does not answer leaves the status as it is.
    }
    // A paused flush keeps its entries: this write clears the pause once storing works again.
    await flusher?.flush({ strict: true })
    return worker.status
}

let source: (() => { worker: RetryWorker; flusher: Flusher | undefined } | undefined) | undefined

/** Storing names its worker and flusher once it starts. */
export const setRetrySource = (next: NonNullable<typeof source>) => {
    source = next
}

/**
 * Try Again: asks the worker again, then flushes what is pending. Resolves with the status after,
 * or undefined before storing started. A caller the user pressed says so when it is still paused.
 */
export const retryStoring = (): Promise<StorageStatus | undefined> => {
    const now = source?.()
    return now ? retryStoringWith(now.worker, now.flusher) : Promise.resolve(undefined)
}
