import { captureStep, type JsonValue, type UndoableStep } from '../../history/operations'
import type { Flusher, FlushSession } from '../../local/flush'
import { fromHex16, toHex } from '../../local/hash'
import { heldItemsOf } from '../../local/heldMedia'
import { toRecords } from '../../local/records/records'
import { encodeSnapshot } from '../../local/records/snapshot'
import type { PendingRecords } from '../../local/save/bodies'
import type { IdentityInput, PendingInput, SaveRefusal, SaveTarget } from '../../local/save/build'
import type { BuiltSave, ExecuteRefusal, SaveSourceFile } from '../../local/save/execute'
import type { HeldMedia } from '../../local/save/media'
import { addRecords, headInput, pendingFlushRow } from '../../local/save/pending'
import type { StorageWorker } from '../../local/worker/client'
import type { BuildSaveOptions } from '../../local/worker/saveHandlers'
import { appVersion, FileError, type PinnedSource } from '../../platform'
import type { State } from '../../state'
import { deviceSource } from './env'

// A Save's build: the options the storage worker's writer takes, with
// what this tab holds that storage may not (its unflushed rows and stack, the live head, its media
// and a binding kept in memory), and the writer's refusals as errors the flows tell apart.

/** A build the writer refused: why, with its message. */
export class BuildRefused extends Error {
    constructor(readonly refusal: SaveRefusal | ExecuteRefusal) {
        super(`The build was refused: ${refusal.refused}`)
        this.name = 'BuildRefused'
    }
}

/** The storage side a build needs: the worker, the flusher and the session saved. */
export type BuildEnv = {
    worker: Pick<StorageWorker, 'call'>
    flusher: Flusher
    session: FlushSession
}

/** A state's root as hex: the binding's hash and a head input's snapshot. */
export const rootOf = (state: State) => toHex(encodeSnapshot(toRecords(state)).root.hash)

/** The head's media this tab holds the bytes of. */
const heldMedia = (state: State): HeldMedia[] =>
    heldItemsOf(state).map(({ hash, bytes, type, filename }) => ({
        hash,
        bytes: new Uint8Array(bytes),
        type,
        ...(filename ? { filename } : {}),
    }))

/**
 * This tab's part of the saved session no store holds yet, as the writer takes it:
 * only while a flush didn't take everything (storage paused or full).
 */
const pendingOf = (env: BuildEnv): PendingInput | undefined => {
    const { entries, stack } = env.flusher.unstored(env.session)
    if (!entries.length) return
    const records: PendingRecords = { roots: {}, nodes: {}, chunks: {} }
    const rows = entries.flatMap((entry) => pendingFlushRow(entry, records) ?? [])
    const slots = stack?.slots.map((slot) => {
        const state = slot.entry?.state
        const snapshot = state
            ? addRecords(records, state)
            : slot.hash
              ? toHex(slot.hash)
              : slot.entry?.snapshot && toHex(slot.entry.snapshot)
        return snapshot === undefined ? undefined : { snapshot, step: captureStep(slot.step) }
    })
    return {
        entries: rows,
        ...(stack && slots?.every((slot) => slot)
            ? {
                  stack: {
                      base: stack.first,
                      slots: slots as { snapshot: string; step: UndoableStep }[],
                      index: stack.index,
                  },
              }
            : {}),
        records,
        startedAt: env.session.startedAt,
    }
}

/** The binding kept in memory while storage is paused, its cut's start as stored. */
const identityOf = async (env: BuildEnv): Promise<IdentityInput | undefined> => {
    const identity = env.session.identity
    if (!identity) return
    const file = identity.file as NonNullable<IdentityInput['file']>
    let entry = file.entry
    if (entry) {
        const empty: Record<string, number> = {}
        const starts = await env.worker
            .call('readSessionStarts', [entry.sessionId])
            .catch(() => empty)
        const startedAt = starts[entry.sessionId]
        if (startedAt !== undefined) entry = { ...entry, startedAt }
    }
    return {
        docId: identity.docId,
        revision: identity.revision,
        file: {
            ...(entry ? { entry } : {}),
            ...(file.completeFrom === undefined ? {} : { completeFrom: file.completeFrom }),
            ...(file.disk ? { disk: file.disk } : {}),
        },
        marks: [...identity.marks],
    }
}

export type BuildRequest = {
    target: SaveTarget
    history: boolean
    bgm: boolean
    fileName: string
    /** The `save` entry's time and label. */
    save: { time: number; operation: JsonValue }
    /** The state saved: the live head when the Save started. */
    state: State
    /** Save to File…: the session written, binding nothing. */
    sessionId?: string
}

/** The build's options as the worker takes them. */
export const buildOptions = async (
    env: BuildEnv,
    request: BuildRequest,
): Promise<BuildSaveOptions> => {
    const own = request.sessionId === undefined
    const pending = own ? pendingOf(env) : undefined
    const identity = own ? await identityOf(env) : undefined
    // A chain storage holds nothing of yet is written from this tab's copy of its record.
    const chain = env.session.chain
    const unstored =
        own && pending && !env.session.stored
            ? {
                  ...chain,
                  chainId: env.session.chainId,
                  docId: env.session.docId,
                  lineageId: env.session.lineageId,
              }
            : undefined
    return {
        history: request.history,
        bgm: request.bgm,
        fileName: request.fileName,
        save: request.save,
        ...(own ? { sessionId: env.session.id } : {}),
        ...(unstored ? { unstored } : {}),
        context: { now: Date.now(), device: deviceSource(), appVersion: appVersion().appVersion },
        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
        ...(pending ? { pending } : {}),
        ...(identity ? { identity } : {}),
        ...(own ? { head: headInput(request.state), media: heldMedia(request.state) } : {}),
    }
}

/** This tab's pending part with the live head's records added, for a head storage can't read. */
const withHeadRecords = (pending: PendingInput | undefined, state: State): PendingInput => {
    const records: PendingRecords = {
        roots: { ...pending?.records.roots },
        nodes: { ...pending?.records.nodes },
        chunks: { ...pending?.records.chunks },
    }
    addRecords(records, state)
    return { ...(pending ?? { entries: [] }), records }
}

/** A build's call can take long on a large chart: the worker reports its progress meanwhile. */
const BUILD_TIMEOUT_MS = 10 * 60_000

/**
 * Builds the file in the storage worker, reading only the pinned sources given. A refusal
 * throws `BuildRefused`, except a changed source, which is a `conflict` `FileError`, so the
 * platform's path applies.
 */
export const runBuild = async (
    env: BuildEnv,
    request: BuildRequest,
    sources: readonly (PinnedSource | SaveSourceFile)[] = [],
): Promise<BuiltSave> => {
    const options = await buildOptions(env, request)
    const call = (options: BuildSaveOptions) =>
        env.worker.call(
            'buildSave',
            {
                chainId: env.session.chainId,
                target: request.target,
                options,
                sources: sources.map((source) => ({
                    token: source.token,
                    role: source.role,
                    file: source.file,
                    fingerprint: 'disk' in source ? source.disk.fingerprint : source.fingerprint,
                })),
            },
            { timeoutMs: BUILD_TIMEOUT_MS },
        )
    let built = await call(options)
    // The head's stored copy failed: an open session's head is always written, from the live
    // state's records. Save to File… of a session that isn't open refuses.
    if ('refused' in built && built.refused === 'unreadableHead' && request.sessionId === undefined)
        built = await call({ ...options, pending: withHeadRecords(options.pending, request.state) })
    if ('refused' in built) {
        if (built.refused === 'conflict' || built.refused === 'notAtBase')
            throw new FileError('conflict', 'The file changed after it was checked')
        throw new BuildRefused(built)
    }
    return built
}

/** The binding's hash: the saved head's root. */
export const headHashOf = (built: BuiltSave) => fromHex16(built.saveEntry.snapshot)
