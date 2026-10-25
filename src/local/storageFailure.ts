// Storage's failures by name. The worker checks its own errors. The page gets only an error's name,
// and its cause's name, across the worker boundary.

/**
 * IndexedDB's errors for storage being unavailable, full or busy, which a later load may not
 * meet. Others (`DataError`, `ConstraintError`, `DataCloneError`…) come back at every load.
 */
export const TRANSIENT_STORAGE_ERRORS: ReadonlySet<string> = new Set([
    'QuotaExceededError',
    'UnknownError',
    'AbortError',
    'InvalidStateError',
    'TransactionInactiveError',
    'TimeoutError',
    'NotReadableError',
])

/** The storage worker's own errors: storing paused, refused or busy, or the worker stopped. */
const STORING_ERRORS: ReadonlySet<string> = new Set([
    'StoragePausedError',
    'StorageRefusedError',
    'MaintTimeoutError',
    'WorkerFailedError',
])

/**
 * Whether an error the page got from the worker is storage's. A paused write is judged by the
 * error that paused it. `NotReadableError` is not counted here: from a stored row it means a
 * value that cannot be read, which comes back at every read.
 */
export const isStorageFailureName = (error: unknown) => {
    if (!(error instanceof Error)) return false
    const { causeName } = error as { causeName?: string }
    const name = error.name === 'StoragePausedError' && causeName ? causeName : error.name
    return (
        name !== 'NotReadableError' &&
        (TRANSIENT_STORAGE_ERRORS.has(name) || STORING_ERRORS.has(name))
    )
}
