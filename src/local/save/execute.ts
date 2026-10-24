import { isNotReadable } from '../../platform/fingerprint'
import { ZipError } from '../../zip/error'
import { zipFingerprint } from '../../zip/fingerprint'
import { ExecutionError, executePlan, type ExecutionSource } from '../nxsp/execute'
import { inspectNxsp } from '../nxsp/inspect'
import type { PinnedSource } from '../nxsp/plan'
import type { SaveStore } from './bodies'
import {
    planSave,
    type SaveOptions,
    type SavePlan,
    type SaveRefusal,
    type SaveTarget,
} from './build'
import { repairFromSource } from './repair'
import { BuiltFileError, checkBuilt } from './verify'

// The web's half after the plan, in the storage worker: the pinned
// files posted with the request are inspected, the plan executed through them, and the result
// checked before anything is handed over. A copy that fails with its source changed is a
// conflict; with it unchanged, damage in that source.

/** A file pinned at the changed-on-disk check, as the page posts it: the `File` itself. */
export type SaveSourceFile = {
    token: string
    role: 'target' | 'base'
    file: Blob
    /** Its fingerprint at the check. */
    fingerprint: string
}

/** A write that can't go on, beyond the plan's refusals. */
export type ExecuteRefusal =
    /** A source changed after the check: the conflict dialog. */
    | { refused: 'conflict' }
    /** The post-build check failed: nothing is handed over. */
    | { refused: 'check'; message: string }

export type BuiltSave = Omit<SavePlan, 'plan'> & { blob: Blob }

type Hooks = { built?: (blob: Blob) => Blob | Promise<Blob> }

let hooks: Hooks = {}

/** Test hooks: `built` alters a built file before the post-build check. */
export const setBuiltHookForTests = (next: Hooks) => {
    hooks = next
}

/**
 * A pinned file's fingerprint now, as the platform pins it (`nxspDiskState`): a file that isn't a
 * readable ZIP is `damaged:`, and a read that fails (the file changed under it) is a change.
 */
export const fingerprintNow = async (file: Blob) => {
    const time = Math.trunc((file as Partial<File>).lastModified ?? 0)
    if (!file.size) return `damaged:0:${time}`
    try {
        return await zipFingerprint(file, time)
    } catch (error) {
        return error instanceof ZipError ? `damaged:${file.size}:${time}` : 'changed'
    }
}

/**
 * Inspects the append source, the only pinned file a write reads: one that isn't a
 * readable `.nxsp` with its fingerprint unchanged is damage in the chain's own file. Other pinned
 * files (a `copy` or `replace` target) aren't read, so they're never taken for damage.
 */
export const inspectSources = async (
    files: readonly SaveSourceFile[],
    target: SaveTarget,
): Promise<PinnedSource[] | SaveRefusal | ExecuteRefusal> => {
    if (target.kind !== 'append') return []
    const sources: PinnedSource[] = []
    for (const { token, role, file, fingerprint } of files) {
        if (token !== target.source) continue
        try {
            sources.push(await inspectNxsp(file, { token, role, fingerprint }))
        } catch (error) {
            if ((await fingerprintNow(file)) !== fingerprint) return { refused: 'conflict' }
            if (error instanceof ZipError || error instanceof SyntaxError)
                return { refused: 'damagedSource', message: error.message }
            if (isNotReadable(error)) return { refused: 'conflict' }
            throw error
        }
    }
    return sources
}

/** Whether any pinned file changed since its check. */
const anyChanged = async (files: readonly SaveSourceFile[]) => {
    for (const { file, fingerprint } of files)
        if ((await fingerprintNow(file)) !== fingerprint) return true
    return false
}

/** Executes a plan over the pinned files and checks the result. */
export const executeSave = async (
    planned: SavePlan,
    files: readonly SaveSourceFile[],
    target?: SaveTarget,
): Promise<BuiltSave | SaveRefusal | ExecuteRefusal> => {
    const sources = new Map<string, ExecutionSource>()
    for (const { token, role, file, fingerprint } of files)
        sources.set(token, {
            file,
            fingerprint,
            role,
            readFingerprint: () => fingerprintNow(file),
        })
    let blob: Blob
    try {
        blob = await executePlan(planned.plan, sources)
    } catch (error) {
        if (!(error instanceof ExecutionError)) throw error
        if (error.code === 'conflict') return { refused: 'conflict' }
        // Only damage in the chain's own file, the append source, unlinks the chain.
        if (
            error.code === 'io' &&
            target?.kind === 'append' &&
            error.source?.token === target.source
        )
            return { refused: 'damagedSource', message: error.message }
        console.error('A save plan failed to execute', error)
        return { refused: 'plan', message: error.message }
    }
    if (hooks.built) blob = await hooks.built(blob)
    try {
        await checkBuilt(blob, planned.storageChunks)
    } catch (error) {
        // The built file reads the pinned files' ranges: a change under them is a conflict.
        if (isNotReadable(error) || (await anyChanged(files))) return { refused: 'conflict' }
        if (!(error instanceof BuiltFileError)) throw error
        console.error('A built file failed its check', error)
        return { refused: 'check', message: error.message }
    }
    const { plan: _plan, ...rest } = planned
    return { ...rest, blob }
}

/**
 * `buildSave` (the Save package's entry): inspects the pinned files, plans the write of the chain,
 * executes and checks it. Resolves the built file with what the write holds, or a
 * refusal that says why nothing was built.
 */
export const buildSave = async (
    store: SaveStore,
    chainId: string,
    target: SaveTarget,
    options: SaveOptions,
    files: readonly SaveSourceFile[] = [],
): Promise<BuiltSave | SaveRefusal | ExecuteRefusal> => {
    // A write-back over a 0-byte file writes the chain from storage, keeping its identity.
    const emptied =
        target.kind === 'append' &&
        files.some((each) => each.token === target.source && each.file.size === 0)
    const kind: SaveTarget = emptied ? { kind: 'copy' } : target
    const sources = await inspectSources(files, kind)
    if (!Array.isArray(sources)) return sources
    const planned = await planSave(store, chainId, kind, options, sources)
    if ('refused' in planned) return planned
    const built = await executeSave(planned, files, kind)
    if (!('refused' in built) && kind.kind === 'append') {
        const source = sources.find((each) => each.token === kind.source)
        const file = files.find((each) => each.token === kind.source)?.file
        // After the check, so it never changes what was built; a failure is only logged.
        if (source && file)
            await repairFromSource(store, source, file).catch((error: unknown) => {
                console.error('Putting damage in storage right from the chain’s file failed', error)
            })
    }
    return built
}
