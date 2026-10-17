import { diskStateOfBytes, platform, type FileTarget } from '../../../platform'
import { exportMemory, sameEntry } from './memory'

// A save picker's pick of the opened file where it may not be written over (§1.4.8, D2, D5).

/** A refused pick: why, and whether the file holds the bytes read at open again. */
export type RefusedPick = {
    name: string
    reason: 'notLevelData' | 'unsupportedParts'
    /** False when the picker emptied it and its bytes could not be put back. */
    restored: boolean
    bytes: ArrayBuffer
}

/** Writes the bytes back while the file is still the empty one the picker left. */
const putBack = async (target: FileTarget, name: string, bytes: ArrayBuffer) => {
    try {
        const disk = await platform.inspect(target)
        if (disk === 'missing') return false
        if (disk.size === 0) {
            await platform.saveFile({
                kind: 'recovery',
                suggestedName: name,
                target,
                expected: disk,
                build: () => Promise.resolve(new Blob([bytes])),
            })
            return true
        }
        // Written since the pick: put back only if it holds the bytes already.
        return (await diskStateOfBytes(bytes, 0)).fingerprint === disk.fingerprint
    } catch {
        return false
    }
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
        restored: await putBack(target, name, bytes),
        bytes,
    }
}

/** Downloads the bytes read at open, for a file that could not be put back. */
export const downloadOpened = (refused: RefusedPick) =>
    platform.saveFile({
        kind: 'recovery',
        suggestedName: refused.name,
        build: () => Promise.resolve(new Blob([refused.bytes])),
    })
