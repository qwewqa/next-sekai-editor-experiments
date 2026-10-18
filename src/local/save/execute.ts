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
import { BuiltFileError, checkBuilt } from './verify'

// The web's half after the plan (Part 1 §1.6.11.7, §1.5.6), in the storage worker: the pinned
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
    /** The post-build check failed: nothing is handed over (§1.5.6). */
    | { refused: 'check'; message: string }

export type BuiltSave = Omit<SavePlan, 'plan'> & { blob: Blob }

type Hooks = { built?: (blob: Blob) => Blob | Promise<Blob> }

let hooks: Hooks = {}

/** Test hooks: `built` alters a built file before the post-build check. */
export const setBuiltHookForTests = (next: Hooks) => {
    hooks = next
}

/** A pinned file's fingerprint now: a read that fails (the file changed under it) is a change. */
export const fingerprintNow = async (file: Blob) => {
    try {
        return await zipFingerprint(file, (file as Partial<File>).lastModified ?? 0)
    } catch {
        return 'changed'
    }
}

/** Inspects the pinned files; a target that isn't a readable `.nxsp` is damage in it. */
export const inspectSources = async (
    files: readonly SaveSourceFile[],
): Promise<PinnedSource[] | SaveRefusal | ExecuteRefusal> => {
    const sources: PinnedSource[] = []
    for (const { token, role, file, fingerprint } of files) {
        try {
            sources.push(await inspectNxsp(file, { token, role, fingerprint }))
        } catch (error) {
            if ((await fingerprintNow(file)) !== fingerprint) return { refused: 'conflict' }
            if (error instanceof ZipError || error instanceof SyntaxError)
                return { refused: 'damagedSource', message: error.message }
            throw error
        }
    }
    return sources
}

/** Executes a plan over the pinned files and checks the result. */
export const executeSave = async (
    planned: SavePlan,
    files: readonly SaveSourceFile[],
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
        if (error.code === 'io' && error.source?.role === 'target')
            return { refused: 'damagedSource', message: error.message }
        console.error('A save plan failed to execute', error)
        return { refused: 'plan', message: error.message }
    }
    if (hooks.built) blob = await hooks.built(blob)
    try {
        await checkBuilt(blob, planned.storageChunks)
    } catch (error) {
        if (!(error instanceof BuiltFileError)) throw error
        console.error('A built file failed its check', error)
        return { refused: 'check', message: error.message }
    }
    const { plan: _plan, ...rest } = planned
    return { ...rest, blob }
}

/**
 * `buildSave` (the Save package's entry): inspects the pinned files, plans the write of the chain
 * (§1.6.11.6), executes and checks it. Resolves the built file with what the write holds, or a
 * refusal that says why nothing was built.
 */
export const buildSave = async (
    store: SaveStore,
    chainId: string,
    target: SaveTarget,
    options: SaveOptions,
    files: readonly SaveSourceFile[] = [],
): Promise<BuiltSave | SaveRefusal | ExecuteRefusal> => {
    const sources = await inspectSources(files)
    if (!Array.isArray(sources)) return sources
    const planned = await planSave(store, chainId, target, options, sources)
    if ('refused' in planned) return planned
    return executeSave(planned, files)
}
