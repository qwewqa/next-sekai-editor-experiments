import { checkFileChunks, openFileCheck, type FileBatchResult, type FileCheck } from '../check/file'
import { finishCheck, type FinishResult } from '../check/finish'
import {
    checkStoredRoots,
    openStoredCheck,
    type StoredBatchResult,
    type StoredCheck,
} from '../check/stored'
import { hashKey } from '../db'
import { fromHex16 } from '../hash'
import type { SaveStore } from '../save/bodies'
import type { ModelRefusal } from '../save/model'
import type { Progress } from './core'
import type { WorkerContext } from './handlers'
import type { CallScope } from './rpc'

// The storage worker's Check File and History… methods (Part 1 §1.4.21). The page drives them
// inside its Save queue, holding `nse-maint` shared from the stored phase's start until it calls
// `checkFinish`: the file phase, the stored phase, then the finish. Each phase's state stays here
// under its id until the finish or `checkDrop`; a worker restart loses it (`notOpened`).

/** Why a call couldn't run: its id isn't open in this worker (a restart, or dropped). */
export type CheckNotOpened = { kind: 'notOpened' }

export type CheckFileOpenResult =
    | { kind: 'damaged' }
    | { kind: 'newer' }
    | { kind: 'readError' }
    /** `batches` of chunks to check with `checkFileBatch`, `bytes` stored bytes in all. */
    | { kind: 'read'; id: string; batches: number; bytes: number }

export type CheckStoredOpenResult =
    | { kind: 'noChain' }
    | { kind: 'refused'; reason: ModelRefusal }
    /** `batches` of roots to check with `checkStoredBatch`, `roots` in all. */
    | { kind: 'opened'; id: string; batches: number; roots: number }

export type CheckHandlerOptions = {
    sleep?: (ms: number) => Promise<void>
}

const realSleep = (ms: number) =>
    new Promise<void>((resolve) => {
        setTimeout(resolve, ms)
    })

export const checkHandlers = (
    context: WorkerContext,
    { sleep = realSleep }: CheckHandlerOptions = {},
) => {
    const files = new Map<string, FileCheck>()
    const stored = new Map<string, StoredCheck>()
    let nextId = 0
    const incarnation = Math.random().toString(36).slice(2)
    const newId = (prefix: string) => `${prefix}-${incarnation}-${nextId++}`
    const storeOf = (progress: Progress): SaveStore => ({
        read: (stores, fn) => context.core.read(stores, fn, progress),
        write: (stores, fn, options) => context.core.write(stores, fn, { ...options, ...progress }),
    })
    return {
        /** Reads the bound file as an open does; its chunks follow in batches. */
        checkFileOpen: async (file: Blob, scope?: CallScope): Promise<CheckFileOpenResult> => {
            scope?.tick()
            const read = await openFileCheck(file).finally(() => scope?.tick())
            if (read.kind !== 'read') return read
            const id = newId('file')
            files.set(id, read.check)
            return { kind: 'read', id, batches: read.check.batches.length, bytes: read.bytes }
        },

        /** One batch of the file's chunks, verified with no stored shortcut: the ones that fail. */
        checkFileBatch: async (
            { id, n }: { id: string; n: number },
            scope?: CallScope,
        ): Promise<FileBatchResult | CheckNotOpened> => {
            const check = files.get(id)
            if (!check) return { kind: 'notOpened' }
            return checkFileChunks(check, n, () => scope?.tick())
        },

        /** Reads the chain's cut and plans its kept rows' roots. */
        checkStoredOpen: async (
            chainId: string,
            scope?: CallScope,
        ): Promise<CheckStoredOpenResult> => {
            const opened = await openStoredCheck(storeOf(scope ?? {}), chainId)
            if (opened.kind !== 'opened') return opened
            const id = newId('stored')
            stored.set(id, opened.check)
            return { kind: 'opened', id, batches: opened.check.batches.length, roots: opened.roots }
        },

        /** One batch of roots and their headers' media; the findings stay here for the finish. */
        checkStoredBatch: async (
            { id, n }: { id: string; n: number },
            scope?: CallScope,
        ): Promise<StoredBatchResult | CheckNotOpened> => {
            const check = stored.get(id)
            if (!check) return { kind: 'notOpened' }
            return checkStoredRoots(storeOf(scope ?? {}), check, n)
        },

        /**
         * The finish: repair from `file` (the bound file, when it was checked and is unchanged),
         * re-check, mark, then remove bad media. The page releases its shared hold first. In
         * read-only storage it writes nothing. The stored phase's state is dropped.
         */
        checkFinish: async (
            { id, file }: { id: string; file?: Blob },
            scope?: CallScope,
        ): Promise<FinishResult | CheckNotOpened> => {
            const check = stored.get(id)
            if (!check) return { kind: 'notOpened' }
            stored.delete(id)
            const progress = scope ?? {}
            const core = context.core
            return finishCheck(storeOf(progress), check, {
                ...(file ? { file } : {}),
                readOnly: core.status.mode === 'readOnly',
                removal: {
                    sleep,
                    exclusive: (body) =>
                        core.exclusive((hold) =>
                            body((hash) =>
                                hold.write(
                                    ['media'],
                                    (tx) => tx.delete('media', hashKey(fromHex16(hash))),
                                    { durability: 'strict' },
                                ),
                            ),
                        ),
                },
            })
        },

        /** Forgets a check's file or stored phase: a cancelled check, or one that ended early. */
        checkDrop: (id: string) => {
            files.delete(id)
            stored.delete(id)
            return true
        },
    }
}

export type CheckHandlers = ReturnType<typeof checkHandlers>
