import { asError, errorName, type KvTx } from './types'

/** What both implementations give the shared transaction wrapper. */
export type RawTransaction = {
    tx: KvTx
    /** Commits explicitly; ignored once finished. */
    commit: () => void
    /** Aborts; ignored once finished. */
    abort: () => void
    /** Resolves on complete, rejects on abort. */
    done: Promise<void>
}

/** Set on an error from a transaction that had already committed before its function failed. */
export const COMMITTED_FIRST = Symbol('committedFirst')

/**
 * Runs fn over the transaction, commits when it resolves and aborts when it throws. Settles once
 * both fn and the transaction have finished.
 */
export const runTransaction = <T>(raw: RawTransaction, fn: (tx: KvTx) => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
        let outcome: { ok: true; value: T } | { ok: false; error: unknown } | undefined
        let finished: { ok: true } | { ok: false; error: unknown } | undefined

        const settle = () => {
            if (!outcome || !finished) return
            if (finished.ok) {
                if (outcome.ok) {
                    resolve(outcome.value)
                    return
                }
                // A request after an outside await: what came before it was committed.
                if (outcome.error && typeof outcome.error === 'object')
                    Object.defineProperty(outcome.error, COMMITTED_FIRST, { value: true })
                reject(asError(outcome.error))
                return
            }
            // Aborted for its own reason (a lost connection, a failed request): that is the cause,
            // even when fn then failed on a request to the finished transaction.
            if (outcome.ok || errorName(finished.error) !== 'AbortError')
                reject(asError(finished.error))
            else reject(asError(outcome.error))
        }

        raw.done.then(
            () => {
                finished = { ok: true }
                settle()
            },
            (error: unknown) => {
                finished = { ok: false, error }
                settle()
            },
        )

        let result: Promise<T>
        try {
            result = fn(raw.tx)
        } catch (error) {
            result = Promise.reject(asError(error))
        }
        result.then(
            (value) => {
                outcome = { ok: true, value }
                raw.commit()
                settle()
            },
            (error: unknown) => {
                outcome = { ok: false, error }
                raw.abort()
                settle()
            },
        )
    })
