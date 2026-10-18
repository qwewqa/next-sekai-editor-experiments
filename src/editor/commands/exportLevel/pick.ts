import { diskStateOfBytes, FileError, platform, type FileTarget } from '../../../platform'
import { exportMemory, sameEntry } from './memory'

// A save picker's pick of the opened file where it may not be written over (§1.4.8, D2, D5).

/**
 * What a refused pick holds now: the bytes read at open, nothing, or something else; `handled`
 * when the Save core shows what happened to the chain's own project file.
 */
export type PickLeft = 'restored' | 'empty' | 'other' | 'handled'

/** A refused pick: why, and what the file holds now. */
export type RefusedPick = {
    name: string
    reason: 'notLevelData' | 'unsupportedParts'
    left: PickLeft
    bytes: ArrayBuffer
    /** `handled`: the Save core's dialog, shown once Export's has closed. */
    show?: () => Promise<void>
}

/** What the file holds now; a missing or unreadable file is "something else". */
const holds = async (target: FileTarget, bytes: ArrayBuffer): Promise<PickLeft> => {
    try {
        const disk = await platform.inspect(target)
        if (disk === 'missing') return 'other'
        if (disk.size === 0) return bytes.byteLength ? 'empty' : 'restored'
        const opened = await diskStateOfBytes(bytes, 0)
        return opened.fingerprint === disk.fingerprint ? 'restored' : 'other'
    } catch {
        return 'other'
    }
}

/** Writes the bytes back while the file is still the empty one the picker left. */
const putBack = async (target: FileTarget, name: string, bytes: ArrayBuffer): Promise<PickLeft> => {
    try {
        const disk = await platform.inspect(target)
        if (disk !== 'missing' && disk.size === 0 && bytes.byteLength) {
            await platform.saveFile({
                kind: 'recovery',
                suggestedName: name,
                target,
                expected: disk,
                build: () => Promise.resolve(new Blob([bytes])),
            })
            return 'restored'
        }
    } catch {
        // What the file holds after a failure is checked below.
    }
    return holds(target, bytes)
}

/**
 * What a pick is to the project picker's rules (§1.4.7 R3–R5), as the Save core tells: the
 * chain's own file written again (`own`), or not (`show` tells why); another chain's file or
 * Export target taken over (`taken`).
 */
export type ProjectPick =
    | 'own'
    | 'taken'
    | { show: () => Promise<void> }
    /** A partial open's file, never written over: its kept bytes go back (R7). */
    | { keep: Promise<Blob | undefined> }
    | undefined

let projectCheck: ((handle: FileSystemFileHandle) => Promise<ProjectPick>) | undefined

type PickLock = <T>(run: () => Promise<T>) => Promise<T>

let pickLock: PickLock | undefined
let targetLock: PickLock | undefined

export const setTargetLock = (lock: PickLock) => {
    targetLock = lock
}
export const withTargetLock: PickLock = (run) => (targetLock ? targetLock(run) : run())

/** Set by the Save core: `nse-bind` exclusive, held from a pick's check to its write (§1.6.6). */
export const setPickLock = (lock: PickLock) => {
    pickLock = lock
}

/** Runs a pick's check and write under the Save core's lock, when there is one. */
export const withPickLock: PickLock = (run) => (pickLock ? pickLock(run) : run())

let exportReads: { start: () => void; end: () => void } | undefined

/** Set by the Save core: Export's dialog reads the chain's own file first when needed (R2). */
export const setExportReads = (reads: typeof exportReads) => {
    exportReads = reads
}

/** Export's dialog opened: the Save core's read first starts (R2). */
export const exportDialogOpened = () => {
    exportReads?.start()
}

/** Export's dialog closed: what it read goes. */
export const exportDialogClosed = () => {
    exportReads?.end()
}

/**
 * Set by the Save core: a pick of this chain's own bound `.nxsp` is rewritten keeping its
 * identity and refused (`own`); another chain's is taken over and written (`taken`).
 */
export const setProjectPickCheck = (check: typeof projectCheck) => {
    projectCheck = check
}

/**
 * Refuses a pick of the file this session was opened from when that was not complete level data
 * (a chart, another engine's level, or a level with parts left out), putting its bytes back.
 */
export const refusePick = async (target: FileTarget): Promise<RefusedPick | undefined> => {
    if (target.kind !== 'handle') return
    // A bound project file (E4, E5): this chain's own is written back and refused.
    const project = await projectCheck?.(target.handle)
    if (typeof project === 'object' && 'keep' in project) {
        const kept = await project.keep
        const bytes = kept ? await kept.arrayBuffer() : new ArrayBuffer(0)
        const { name } = target.handle
        return {
            name,
            reason: 'notLevelData',
            left: kept ? await putBack(target, name, bytes) : 'empty',
            bytes,
        }
    }
    if (project === 'own' || typeof project === 'object')
        return {
            name: target.handle.name,
            reason: 'notLevelData',
            left: project === 'own' ? 'restored' : 'handled',
            bytes: new ArrayBuffer(0),
            ...(typeof project === 'object' ? { show: project.show } : {}),
        }
    const { opened } = exportMemory
    const bytes = opened?.bytes
    if (!opened || !bytes) return
    if (!(await sameEntry(target.handle, opened.handle))) return
    const { name } = target.handle
    return {
        name,
        reason: opened.levelData ? 'unsupportedParts' : 'notLevelData',
        left: await putBack(target, name, bytes),
        bytes,
    }
}

/** Downloads the bytes read at open, for a file that could not be put back. */
export const downloadOpened = async (refused: RefusedPick) => {
    try {
        return await platform.saveFile({
            kind: 'recovery',
            suggestedName: refused.name,
            build: () => Promise.resolve(new Blob([refused.bytes])),
        })
    } catch (error) {
        // Any failure here is the download's, shown as such.
        const message = error instanceof Error ? error.message : String(error)
        throw new FileError('io', message, undefined, 'download', refused.name)
    }
}
