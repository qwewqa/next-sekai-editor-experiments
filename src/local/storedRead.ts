import { recordError } from '../diagnostics'
import type { CallOptions } from './worker/rpc'
import type { StorageHandlers } from './worker/storage.worker'

// The `storedRead` gate: the storage reads whose empty or absent answer a caller acts on are made
// only here (lint `local/stored-reads`). A failed call rejects, and the gate turns that into a
// value beside the answers, so "none found" and "could not look" stay apart up to the code that
// decides what each means. A wrapper over such a read returns the same type and never decides the
// failed case for its callers; it may map a value.

/** A storage read's answer, or its failure (recorded in the diagnostics ring). */
export type StoredRead<T> =
    | { readonly storedRead: 'value'; readonly storedValue: T }
    | { readonly storedRead: 'failed'; readonly storedError: unknown }

/**
 * The methods whose empty or absent answer a caller acts on: no handle, no owners, no binding, no
 * chain, no guard, no earlier chains, no pending import, no import target, nothing to recover, a
 * recovered row gone, no kept copy, no edits here, no damage found, no Recent Sessions, no chain
 * to Delete. A new storage method is classified when it is added (`storedReadClasses.test.ts`).
 */
export const COVERED_READS = [
    'readHandle',
    'listHandleOwners',
    'readBindings',
    'readChainRecord',
    'replaceDecision',
    'openEarlierChains',
    'openPendingImports',
    'openImportTarget',
    'listRecovered',
    'readRecovered',
    'listKept',
    'findEdits',
    'deleteTarget',
    'checkStoredOpen',
    'checkStoredBatch',
    'listRecent',
] as const

export type CoveredRead = (typeof COVERED_READS)[number]

type Answer<K extends CoveredRead> = Awaited<ReturnType<StorageHandlers[K]>>
type Arg<K extends CoveredRead> = Parameters<StorageHandlers[K]>[0]

/**
 * What the gate needs of a worker: `StorageWorker`, or a test's double. Method syntax, so
 * `@typescript-eslint/unbound-method` reports any detaching: `StorageWorker.call` needs its `this`.
 */
export type ReadWorker = {
    call(method: keyof StorageHandlers, arg?: never, options?: CallOptions): Promise<unknown>
}

/** A covered read: its answer, or `failed`. Never rejects; a failure is recorded once. */
export const storedRead = async <K extends CoveredRead>(
    worker: ReadWorker,
    method: K,
    arg: Arg<K>,
    options?: CallOptions,
): Promise<StoredRead<Answer<K>>> => {
    try {
        // Called on the worker object, never detached.
        const answer = (await worker.call(method, arg as never, options)) as Answer<K>
        return { storedRead: 'value', storedValue: answer }
    } catch (error) {
        recordError(error)
        return { storedRead: 'failed', storedError: error }
    }
}

/** A successful read's answer, for a wrapper that maps one. */
export const readValue = <T>(value: T): StoredRead<T> => ({
    storedRead: 'value',
    storedValue: value,
})

/** The answer mapped, the failure kept. */
export const mapRead = <T, U>(read: StoredRead<T>, map: (value: T) => U): StoredRead<U> => {
    switch (read.storedRead) {
        case 'value':
            return readValue(map(read.storedValue))
        case 'failed':
            // The failure goes on to the caller, which decides what it means.
            return read
    }
}
