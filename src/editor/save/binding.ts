import type { FlushSession } from '../../local/flush'
import { handleOf } from '../../local/handles'
import { mapRead, readValue, storedRead, type StoredRead } from '../../local/storedRead'
import type { DiskState } from '../../platform'
import type { BuildEnv } from './build'
import { heldHandle } from './env'
import { revokedOf } from './watch'

// The Save core's view of the open session's binding (Part 1 §1.3.2, §1.4.7): the environment the
// flows run in, the binding a press decides by, the record read again (R10), and the handle.

/** The binding as the chain record holds it (§1.6.11.2). */
export type StoredFile = {
    name: string
    event: 'opened' | 'saved' | 'downloaded'
    at: number
    hash: Uint8Array
    entry?: {
        sessionId: string
        seq: number
        startedAt: number
        count: number
        notKept: number
        inexact?: true
    }
    completeFrom?: string
    disk?: DiskState
    confirmed?: true
}

/** The chain's identity fields as a Save reads them: stored, or kept in memory. */
export type Binding = {
    docId: string
    revision?: { id: string; n: number; ancestors: string[] }
    file?: StoredFile
    replaced?: { by: string; at: number; name: string }
}

/** What a Save runs in: the storage worker, the flusher, and the open session of its chain. */
export type Env = BuildEnv & { readonly chainId: string }

type Row = Record<string, unknown>

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null

let getEnvironment: (() => Env | undefined) | undefined

/**
 * Set once by `local/storing.ts`, which owns the storage worker and the flusher. The getter is
 * read at each call: a fork or an open changes the session between two of them.
 */
export const setSaveEnvironment = (get: () => Env | undefined) => {
    getEnvironment = get
}

/** The storage worker, the flusher and its open session now; none before storing started. */
export const environment = (): Env | undefined => getEnvironment?.()

/** The binding of a record, with the one kept in memory over it (storage paused, §1.3.2). */
export const bindingOf = (record: Row | undefined, session: FlushSession): Binding => {
    const identity = session.identity
    const source: Row = identity
        ? { ...record, docId: identity.docId, revision: identity.revision, file: identity.file }
        : (record ?? {})
    const file =
        isRow(source.file) && typeof source.file.name === 'string' ? source.file : undefined
    return {
        docId: typeof source.docId === 'string' ? source.docId : session.docId,
        ...(isRow(source.revision) ? { revision: source.revision as Binding['revision'] } : {}),
        ...(file ? { file: file as unknown as StoredFile } : {}),
        ...(!identity && isRow(source.replaced)
            ? { replaced: source.replaced as Binding['replaced'] }
            : {}),
    }
}

/** The record as this tab last wrote it: what a press decides by, before the check. */
export const quickBinding = (env: Env) => bindingOf(env.session.chain, env.session)

/** The record read again (R10), with a revocation localStorage holds for it (R11). */
export const readBinding = async (env: Env): Promise<StoredRead<Binding>> =>
    mapRead(await storedRead(env.worker, 'readChainRecord', env.chainId), (record) => {
        // Taken over since: by the record, or by a key kept while storage couldn't take it (R11).
        const replaced = revokedOf(record, env.session) as Binding['replaced'] | undefined
        if (replaced) {
            const binding = bindingOf(record, { ...env.session, identity: undefined })
            return {
                docId: binding.docId,
                ...(binding.revision ? { revision: binding.revision } : {}),
                replaced,
            }
        }
        return bindingOf(record, env.session)
    })

/**
 * The handle of the chain's binding: this tab's, else the stored one, read when needed (D24).
 * `undefined` is an answer (none stored, or another file's); a failed read is `failed`.
 */
export const bindingHandle = async (
    env: Env,
    file: StoredFile,
): Promise<StoredRead<FileSystemFileHandle | undefined>> => {
    const held = heldHandle(env.chainId, file.name)
    if (held) return readValue(held)
    return mapRead(await handleOf(env.worker, env.chainId, 'file'), (stored) =>
        stored?.name === file.name ? stored : undefined,
    )
}
