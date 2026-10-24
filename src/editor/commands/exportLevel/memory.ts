import { onResetState } from '../../../history/resetHooks'
import { storableHandleNow } from '../../../local/handles'
import { nextCopyName } from '../../../local/names'
import type { StoredRead } from '../../../local/storedRead'
import type { DiskState } from '../../../platform'

// Export's remembered target and names: this tab's view of the chain's
// `exportTarget`, `exportName` and the partial import's flag, stored on the chain record
// whenever they change, and read back when a stored session opens. The target's handle
// is stored apart and read only when Export needs it. A new chart clears it; a fork drops
// the target and the name.

/** Bytes kept at an open for a picker that empties the file: in memory up to this. */
export const KEPT_BYTES_LIMIT = 64 * 1024 * 1024

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
    /** Level data whose import left parts out, so it is never written over. */
    partial: boolean
    /** The bytes read, for a file never written over, to put back if a picker empties it. */
    bytes?: ArrayBuffer
    /** A `.nxsp`: whole, it's the chain's own bound file; partial, it's never written over. */
    project?: true
    /**
     * A partial or unlinked `.nxsp` open's bytes, kept for a picker that empties the file:
     * resolves once they're kept, whatever their size.
     */
    keptCopy?: Promise<Blob | undefined>
    /**
     * The bytes read, for the project picker: it never writes over level data or a chart,
     * which Export may.
     */
    kept?: ArrayBuffer
}

export type ExportMemory = {
    target?: ExportTarget
    /** The name used last for this session's level data, as typed, without `.nsld`. */
    exportName?: string
    /** The gzipped level data file this session was imported from, by its own name. */
    sourceName?: string
    /** Imported from level data with parts left out: pickers suggest "<name> (2)". */
    partial?: boolean
    opened?: OpenedSource
}

export const exportMemory: ExportMemory = {}

/** The stored target as read, while this tab has not read its handle: kept as it is. */
let storedTarget: ExportChainFields['exportTarget'] | undefined
const registered = new WeakMap<ExportTarget, { name: string; fingerprint: string }>()

/** A rewrite retains its last stored ownership even when the next metadata write fails. */
export const replaceExportTarget = async (target: ExportTarget) => {
    const previous = exportMemory.target
    const registration = previous && registered.get(previous)
    if (registration && (await sameEntry(previous.handle, target.handle)))
        registered.set(target, registration)
    exportMemory.target = target
}

/** Drops the destination and name after a new-identity Save As. */
export const clearExportDestination = () => {
    storedTarget = undefined
    delete exportMemory.target
    delete exportMemory.exportName
    delete exportMemory.sourceName
}

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

/** The chain fields this memory is stored as, `undefined` removing one. */
export type ExportChainFields = {
    /** `handle` goes to the `handles` store, never the record. */
    exportTarget: { name: string; handle?: unknown; disk: DiskState; opened?: true }
    exportName: string
    /** Imported from level data with parts left out: pickers suggest "<name> (2)". */
    partialImport: true
}

let persist:
    ((fields: Partial<Record<keyof ExportChainFields, unknown>>) => Promise<boolean>) | undefined

/** Where the memory is stored: the open session's chain record, set once storing starts. */
export const setExportPersister = (fn: typeof persist) => {
    persist = fn
}

let readHandle: (() => Promise<StoredRead<FileSystemFileHandle | undefined>>) | undefined

/**
 * How Export reads the stored target's handle: the open chain's, set once storing starts. A failed
 * read is no target (a picker asks), as when none is stored.
 */
export const setExportHandleReader = (fn: typeof readHandle) => {
    readHandle = fn
}

/** Stores the memory on the chain record, as it is now. */
export const rememberExport = async () => {
    const { target, exportName, partial } = exportMemory
    const handle = target && storableHandleNow(target.handle)
    const stored = await persist?.({
        // A target read back whose handle this tab hasn't read stays as it is, its handle too.
        ...(target || !storedTarget
            ? {
                  exportTarget: target
                      ? {
                            name: target.name,
                            ...(handle ? { handle } : {}),
                            disk: target.disk,
                            ...(target.exported ? {} : { opened: true }),
                        }
                      : undefined,
              }
            : {}),
        exportName,
        partialImport: partial ? true : undefined,
    })
    if (stored && target)
        registered.set(target, { name: target.name, fingerprint: target.disk.fingerprint })
}

let readTarget: (() => Promise<StoredRead<unknown> | undefined>) | undefined
let unregisteredCheck: ((target: ExportTarget) => Promise<boolean>) | undefined

export const setUnregisteredTargetCheck = (check: typeof unregisteredCheck) => {
    unregisteredCheck = check
}

export const setExportTargetReader = (read: typeof readTarget) => {
    readTarget = read
}

/** Rechecks ownership; a failed read never authorizes a previously registered destination. */
export const ownsExportTarget = async (target: ExportTarget) => {
    if (exportMemory.target !== target) return false
    if (!readTarget) return true
    const read = await readTarget()
    // A failed read is no record: it never authorizes a previously registered destination.
    const record = read?.storedRead === 'value' ? read.storedValue : undefined
    if (isObject(record) && isObject(record.exportTarget)) {
        const current = record.exportTarget
        const expected = registered.get(target) ?? {
            name: target.name,
            fingerprint: target.disk.fingerprint,
        }
        if (
            current.name === expected.name &&
            isObject(current.disk) &&
            current.disk.fingerprint === expected.fingerprint
        ) {
            registered.set(target, expected)
            return true
        }
    }
    if (!registered.has(target) && (!unregisteredCheck || (await unregisteredCheck(target))))
        return true
    if (exportMemory.target === target) delete exportMemory.target
    storedTarget = undefined
    return false
}

const hasTarget = () => exportMemory.target !== undefined

/**
 * The remembered target, its stored handle read when Export needs it; undefined when there
 * is none, or no handle was stored (a picker then asks where).
 */
export const loadExportTarget = async (): Promise<ExportTarget | undefined> => {
    const stored = storedTarget
    if (exportMemory.target) {
        return (await ownsExportTarget(exportMemory.target)) ? exportMemory.target : undefined
    }
    if (!stored || !readHandle) return
    const read = await readHandle()
    // A failed read is no target, as when none is stored: the picker asks.
    const handle = read.storedRead === 'value' ? read.storedValue : undefined
    // An Export or a new chart meanwhile has its own target.
    if (handle && !hasTarget() && storedTarget === stored) {
        exportMemory.target = {
            name: stored.name,
            handle,
            disk: stored.disk,
            exported: stored.opened !== true,
        }
        registered.set(exportMemory.target, {
            name: stored.name,
            fingerprint: stored.disk.fingerprint,
        })
        storedTarget = undefined
        if (!(await ownsExportTarget(exportMemory.target))) return
    }
    return exportMemory.target
}

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null

/** Reads the memory back from a stored chain record, when a stored session opens. */
export const restoreExportMemory = (chain: Record<string, unknown>) => {
    clearExportMemory()
    const target = chain.exportTarget
    if (isObject(target) && typeof target.name === 'string' && isObject(target.disk)) {
        // Its handle is read when Export needs it (`loadExportTarget`), never here at startup.
        storedTarget = target as ExportChainFields['exportTarget']
        // The opened file's own name, which the picker suggests.
        if (target.opened === true) exportMemory.sourceName = target.name
    }
    if (typeof chain.exportName === 'string') exportMemory.exportName = chain.exportName
    if (chain.partialImport === true) exportMemory.partial = true
}

/** The name a picker suggests: the next copy's for an unlinked copy, so it is not the original's. */
export const copyName = (name: string) => (name && exportMemory.partial ? nextCopyName(name) : name)

/** Whether two handles name one file; false where the browser cannot tell. */
export const sameEntry = async (a: FileSystemFileHandle, b: FileSystemFileHandle) => {
    if (a === b) return true
    try {
        return await a.isSameEntry(b)
    } catch {
        return false
    }
}
