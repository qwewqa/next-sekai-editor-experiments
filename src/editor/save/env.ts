import { liveState } from '../../history/stack'
import { documentDeviceId, type DeviceSource } from '../../local/deviceId'
import { fromHex16, toHex } from '../../local/hash'
import { hasWebLocks } from '../../local/locks'
import type { SaveEntryForm } from '../../local/save/bind'
import type { IdentityUnit } from '../../local/save/commit'
import { storedRead, type ReadWorker } from '../../local/storedRead'
import { platform } from '../../platform'
import { detection } from '../../platform/detect'
import type { LockMode } from '../../platform/types'
import { storageGet, storageKey, storageRemove, storageSet } from '../../storage'

// What the Save core keeps outside storage (Part 1 §1.4.7): this browser's device, the handles
// this tab picked, `nse-bind` and the marker of a write whose binding isn't stored yet (our own
// completed Save).

/** The lock that keeps one writer per file (§1.6.6, owner decision log D5). */
export const BIND_LOCK = 'nse-bind'

/**
 * Runs `fn` holding `nse-bind`. Download browsers never request it (they have no handles), nor do
 * pages without Web Locks, where no other tab can be told apart.
 */
export const withBind = <T>(mode: LockMode, fn: () => Promise<T>): Promise<T> =>
    platform.capabilities.writeBack && hasWebLocks()
        ? platform.locks.request(BIND_LOCK, { mode }, fn)
        : fn()

let memoryDeviceId: string | undefined

/**
 * This browser's `deviceId` (§1.3.3), kept in localStorage; in memory where it can't be. Files
 * never hold it: they record the device id derived from it per lineage (`ownDeviceId`).
 */
export const deviceId = () => {
    const stored = storageGet('deviceId', undefined)
    if (typeof stored === 'string' && stored) return stored
    memoryDeviceId ??= crypto.randomUUID()
    try {
        storageSet('deviceId', memoryDeviceId)
    } catch {
        // Kept in memory for this page.
    }
    return memoryDeviceId
}

/** "Web (Chrome)", "Web (Edge)", "Web (Firefox)", "Web (Safari)" (§1.3.3). */
export const deviceLabel = () => {
    const { engine } = detection()
    const agent = typeof navigator === 'undefined' ? '' : navigator.userAgent
    switch (engine) {
        case 'chromium':
            return agent.includes(' Edg/') ? 'Web (Edge)' : 'Web (Chrome)'
        case 'firefox':
            return 'Web (Firefox)'
        case 'webkit':
            return 'Web (Safari)'
        case 'other':
            return 'Web'
    }
}

/** What a Save is given: the file records the device of its lineage, derived from it (§1.3.3). */
export const deviceSource = (): DeviceSource => ({ deviceId: deviceId(), label: deviceLabel() })

let ownDevice: { deviceId: string; lineageId: string; id: string } | undefined

/** This browser's device id in files of `lineageId` (§1.3.3): a save there with it is its own. */
export const ownDeviceId = (lineageId: string) => {
    const id = deviceId()
    if (ownDevice?.deviceId !== id || ownDevice.lineageId !== lineageId)
        ownDevice = { deviceId: id, lineageId, id: documentDeviceId(id, lineageId) }
    return ownDevice.id
}

// The handles this tab picked or read, by chain: the main thread's own copy for permission
// requests and writes (§1.3.2).
const handles = new Map<string, { name: string; handle: FileSystemFileHandle }>()

export const rememberHandle = (chainId: string, handle: FileSystemFileHandle) => {
    handles.set(chainId, { name: handle.name, handle })
}

export const forgetHandle = (chainId: string) => {
    handles.delete(chainId)
}

/** The handle this tab holds for a chain's binding named `name`. */
export const heldHandle = (chainId: string, name: string) => {
    const held = handles.get(chainId)
    return held?.name === name ? held.handle : undefined
}

// The marker of a write not yet recorded: what our own completed Save commits (§1.4.7).

/** A write whose binding isn't stored yet: its `save` entry and identity unit, hashes as hex. */
export type SaveMarker = {
    chainId: string
    entry: SaveEntryForm
    /** The binding's revision before the write, or null for a new `docId`: the file's parent. */
    parent: string | null
    unit: Omit<IdentityUnit, 'file'> & { file: Record<string, unknown> & { hash: string } }
}

const markerKey = (chainId: string) => `saving.${chainId}`

/** Writes a write's marker before the write starts; false when it can't be kept. */
export const writeMarker = (marker: SaveMarker) => {
    try {
        storageSet(markerKey(marker.chainId), marker)
        return true
    } catch {
        return false
    }
}

export const readMarker = (chainId: string): SaveMarker | undefined => {
    // A marker this build did not write may lack either part.
    const value = storageGet(markerKey(chainId), undefined) as Partial<SaveMarker> | undefined
    return typeof value?.entry?.revisionId === 'string' && typeof value.unit?.docId === 'string'
        ? (value as SaveMarker)
        : undefined
}

/** Removes a chain's marker once its binding is stored, unless a later write replaced it. */
export const removeMarker = (chainId: string, revisionId?: string) => {
    if (revisionId !== undefined && readMarker(chainId)?.entry.revisionId !== revisionId) return
    try {
        storageRemove(markerKey(chainId))
    } catch {
        // A stale marker is checked by revision before it's used.
    }
}

/** A chain's kept bytes in OPFS: listed and removed by the reclaim. */
export type KeptCopies = {
    chains: () => Promise<string[]>
    remove: (chainId: string) => Promise<void>
}

/**
 * Removes what a deleted chain left on this side of storage: its Save marker and its kept bytes,
 * at a load's idle time. Each goes only when the record read worked and found no chain (definite
 * deletion).
 */
export const reclaimOrphans = async (worker: ReadWorker, kept?: KeptCopies) => {
    const chains = new Set<string>()
    try {
        const prefix = storageKey('saving.')
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i)
            if (key?.startsWith(prefix)) chains.add(key.slice(prefix.length))
        }
    } catch {
        // No localStorage: only kept bytes to look at.
    }
    const copies = new Set(kept ? await kept.chains() : [])
    for (const chainId of [...chains, ...copies]) {
        const read = await storedRead(worker, 'readChainRecord', chainId)
        // A failed read keeps everything: it goes only when the read worked and found no chain.
        if (read.storedRead !== 'value' || read.storedValue !== undefined) continue
        removeMarker(chainId)
        if (copies.has(chainId)) await kept?.remove(chainId)
    }
}

/** The `seq` a marker reserved in a session: a resumed session goes past it. */
export const markedSeq = (sessionId: string) => {
    const prefix = storageKey('saving.')
    let seq: number | undefined
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i)
            if (!key?.startsWith(prefix)) continue
            const marker = readMarker(key.slice(prefix.length))
            if (marker?.entry.sessionId === sessionId) seq = Math.max(seq ?? 0, marker.entry.seq)
        }
    } catch {
        return
    }
    return seq
}

/** The binding a marker commits, its hash back as bytes. */
export const markerUnit = (marker: SaveMarker): IdentityUnit => ({
    ...marker.unit,
    file: { ...marker.unit.file, hash: fromHex16(marker.unit.file.hash) },
})

/** A binding's file with its hash as hex, for a marker. */
export const markerFile = (file: Record<string, unknown>) => {
    const { handle: _handle, hash, ...rest } = file
    return { ...rest, hash: hash instanceof Uint8Array ? toHex(hash) : String(hash) }
}

/** The live state, never a peek (Save acts on the live session, §1.4.7). */
export const savedState = () => liveState.value
