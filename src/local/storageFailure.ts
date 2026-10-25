// Storage's failures by name: the worker's own checks, and the page's, which gets only an error's
// name across the worker boundary.

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

/** Errors of the storage worker's own for storing paused, refused or busy, or the worker stopped. */
const STORING_ERRORS: ReadonlySet<string> = new Set([
    'StoragePausedError',
    'StorageRefusedError',
    'MaintTimeoutError',
    'WorkerFailedError',
])

/** Whether an error the page got from the worker is storage's, by its name. */
export const isStorageFailureName = (name: string) =>
    TRANSIENT_STORAGE_ERRORS.has(name) || STORING_ERRORS.has(name)
