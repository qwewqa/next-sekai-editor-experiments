import { onResetState } from '../../../history/resetHooks'
import type { DiskState } from '../../../platform'

// Export's remembered target and names (Part 1 §1.4.8): this tab's view of the chain's
// `exportTarget`, `exportName` and the partial import's flag, stored on the chain record
// (§1.3.1) whenever they change, and read back when a stored session opens. A new chart clears
// it; a fork drops the target and the name (Step 1c's stub `exportTargetMemory`, retired).

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
    /** Level data whose import left parts out, so it is never written over (D2). */
    partial: boolean
    /** The bytes read, for a file never written over, to put back if a picker empties it (D5). */
    bytes?: ArrayBuffer
}

export type ExportMemory = {
    target?: ExportTarget
    /** The name used last for this session's level data, as typed, without `.nsld`. */
    exportName?: string
    /** The gzipped level data file this session was imported from, by its own name. */
    sourceName?: string
    /** Imported from level data with parts left out: pickers suggest "<name> (2)" (§1.4.7). */
    partial?: boolean
    opened?: OpenedSource
}

export const exportMemory: ExportMemory = {}

/** The stored target as read, while this tab has no handle for it: kept as it is. */
let storedTarget: ExportChainFields['exportTarget'] | undefined

/** Forgets the target and names, as a new chart does. */
export const clearExportMemory = () => {
    storedTarget = undefined
    delete exportMemory.target
    delete exportMemory.exportName
    delete exportMemory.sourceName
    delete exportMemory.partial
    delete exportMemory.opened
}

onResetState(clearExportMemory)

/** The chain fields this memory is stored as (§1.6.11.2), `undefined` removing one. */
export type ExportChainFields = {
    exportTarget: { name: string; handle?: FileSystemFileHandle; disk: DiskState; opened?: true }
    exportName: string
    /** Imported from level data with parts left out: pickers suggest "<name> (2)". */
    partialImport: true
}

let persist: ((fields: Partial<Record<keyof ExportChainFields, unknown>>) => void) | undefined

/** Where the memory is stored: the open session's chain record, set once storing starts. */
export const setExportPersister = (fn: typeof persist) => {
    persist = fn
}

/** Stores the memory on the chain record, as it is now. */
export const rememberExport = () => {
    const { target, exportName, partial } = exportMemory
    persist?.({
        exportTarget: target
            ? {
                  name: target.name,
                  // The handle stays in this tab: a page that reads an OPFS handle back from
                  // IndexedDB is killed in the browsers the specs run (D16), so the stored
                  // target names the file and Export asks where after a reload.
                  disk: target.disk,
                  ...(target.exported ? {} : { opened: true }),
              }
            : // Read back without its handle: this tab never changed it, so it stays.
              storedTarget,
        exportName,
        partialImport: partial ? true : undefined,
    })
}

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null

/** Reads the memory back from a stored chain record, when a stored session opens. */
export const restoreExportMemory = (chain: Record<string, unknown>) => {
    clearExportMemory()
    const target = chain.exportTarget
    if (isObject(target) && typeof target.name === 'string' && isObject(target.disk)) {
        const handle = target.handle as FileSystemFileHandle | undefined
        if (handle)
            exportMemory.target = {
                name: target.name,
                handle,
                disk: target.disk as DiskState,
                exported: target.opened !== true,
            }
        else storedTarget = target as ExportChainFields['exportTarget']
        // The opened file's own name, which the picker suggests (§1.4.8).
        if (target.opened === true) exportMemory.sourceName = target.name
    }
    if (typeof chain.exportName === 'string') exportMemory.exportName = chain.exportName
    if (chain.partialImport === true) exportMemory.partial = true
}

/** The name a picker suggests: "<name> (2)" for an unlinked copy, so it is not the original's. */
export const copyName = (name: string) => (name && exportMemory.partial ? `${name} (2)` : name)

/** Whether two handles name one file; false where the browser cannot tell. */
export const sameEntry = async (a: FileSystemFileHandle, b: FileSystemFileHandle) => {
    if (a === b) return true
    try {
        return await a.isSameEntry(b)
    } catch {
        return false
    }
}
