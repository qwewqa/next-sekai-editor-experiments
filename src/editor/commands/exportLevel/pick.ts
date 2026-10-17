import { diskStateOfBytes, FileError, platform, type FileTarget } from '../../../platform'
import { exportMemory, sameEntry } from './memory'

// A save picker's pick of the opened file where it may not be written over (§1.4.8, D2, D5).

/** What a refused pick holds now: the bytes read at open, nothing, or something else. */
export type PickLeft = 'restored' | 'empty' | 'other'

/** A refused pick: why, and what the file holds now. */
export type RefusedPick = {
    name: string
    reason: 'notLevelData' | 'unsupportedParts'
    left: PickLeft
    bytes: ArrayBuffer
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
 * Refuses a pick of the file this session was opened from when that was not complete level data
 * (a chart, another engine's level, or a level with parts left out), putting its bytes back.
 */
export const refusePick = async (target: FileTarget): Promise<RefusedPick | undefined> => {
    const { opened } = exportMemory
    const bytes = opened?.bytes
    if (target.kind !== 'handle' || !opened || !bytes) return
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
