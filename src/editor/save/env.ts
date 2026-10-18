import { liveState } from '../../history/stack'
import { fromHex16, toHex } from '../../local/hash'
import { hasWebLocks } from '../../local/locks'
import type { Revocation, SaveEntryForm } from '../../local/save/bind'
import type { IdentityUnit } from '../../local/save/commit'
import { platform } from '../../platform'
import { detection } from '../../platform/detect'
import type { LockMode } from '../../platform/types'
import { storageGet, storageKey, storageRemove, storageSet } from '../../storage'

// What the Save core keeps outside storage (Part 1 §1.4.7): this browser's device, the handles
// this tab picked, `nse-bind`, `revoke.<chainId>` (R11) and the marker of a write whose binding
// isn't stored yet (our own completed Save).

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

/** This browser's `deviceId` (§1.3.3), kept in localStorage; in memory where it can't be. */
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

export const deviceForm = () => ({ id: deviceId(), label: deviceLabel() })

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

// R11: a revocation storage couldn't take.

const revokeKey = (chainId: string) => `revoke.${chainId}`

export const readRevocation = (chainId: string): Revocation | undefined => {
    const value = storageGet(revokeKey(chainId), undefined) as Partial<Revocation> | undefined
    if (
        typeof value?.by !== 'string' ||
        typeof value.at !== 'number' ||
        typeof value.name !== 'string' ||
        typeof value.fileAt !== 'number'
    )
        return
    return value as Revocation
}

/** Writes a revocation and reads it back: true only when it's there. */
export const writeRevocation = (chainId: string, revoke: Revocation) => {
    try {
        storageSet(revokeKey(chainId), revoke)
        return JSON.stringify(readRevocation(chainId)) === JSON.stringify(revoke)
    } catch {
        return false
    }
}

export const removeRevocation = (chainId: string) => {
    try {
        storageRemove(revokeKey(chainId))
    } catch {
        // Applied already: a stale key names a binding that's gone, and is skipped.
    }
}

/** Every chain with a revocation waiting. */
export const pendingRevocations = () => {
    const prefix = storageKey('revoke.')
    const found: { chainId: string; revoke: Revocation }[] = []
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i)
            if (!key?.startsWith(prefix)) continue
            const chainId = key.slice(prefix.length)
            const revoke = readRevocation(chainId)
            if (revoke) found.push({ chainId, revoke })
        }
    } catch {
        // No localStorage: nothing was kept there.
    }
    return found
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
    const value = storageGet(markerKey(chainId), undefined) as SaveMarker | undefined
    return typeof value?.entry.revisionId === 'string' && typeof value.unit.docId === 'string'
        ? value
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

/** Removes the markers of chains storage no longer holds (deleted), at a load's idle time. */
export const sweepMarkers = async (worker: {
    call: (method: 'readChainRecord', chainId: string) => Promise<unknown>
}) => {
    const prefix = storageKey('saving.')
    const chains: string[] = []
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i)
            if (key?.startsWith(prefix)) chains.push(key.slice(prefix.length))
        }
    } catch {
        return
    }
    for (const chainId of chains) {
        const record = await worker.call('readChainRecord', chainId).catch(() => null)
        // Undefined only when the read worked and found no chain.
        if (record === undefined) removeMarker(chainId)
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
