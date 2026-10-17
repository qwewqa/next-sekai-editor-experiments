import { onResetState } from '../../../history/resetHooks'
import type { DiskState } from '../../../platform'

// The stub `exportTargetMemory` (Part 1 §1.11.1, Step 1c): Export's remembered target and names,
// held in this tab's memory until Step 4 adds the chain fields. A new chart clears it.

export type ExportTarget = {
    /** The file's name, as shown: "LevelData". */
    name: string
    handle: FileSystemFileHandle
    /** The file as last read or written here; its fingerprint is the sha256 of its bytes. */
    disk: DiskState
    /** Exported to; otherwise it is the opened file, not exported to yet. */
    exported: boolean
}

/** The file this session was opened from, as read at the open. */
export type OpenedSource = {
    handle: FileSystemFileHandle
    /** This engine's level data by content; a chart or another engine's level is not. */
    levelData: boolean
    /** The bytes read, to put back if a save picker empties the file (D5). */
    bytes?: ArrayBuffer
}

export type ExportMemory = {
    target?: ExportTarget
    /** The name used last for this session's level data, as typed, without `.nsld`. */
    exportName?: string
    /** The gzipped level data file this session was imported from, by its own name. */
    sourceName?: string
    opened?: OpenedSource
}

export const exportMemory: ExportMemory = {}

/** Forgets the target and names, as a new chart does. */
export const clearExportMemory = () => {
    delete exportMemory.target
    delete exportMemory.exportName
    delete exportMemory.sourceName
    delete exportMemory.opened
}

onResetState(clearExportMemory)

/** Whether two handles name one file; false where the browser cannot tell. */
export const sameEntry = async (a: FileSystemFileHandle, b: FileSystemFileHandle) => {
    if (a === b) return true
    try {
        return await a.isSameEntry(b)
    } catch {
        return false
    }
}
