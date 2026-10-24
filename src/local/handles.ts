import { platformOverride, suspectPrivate, usesOpfsPickers } from '../platform/detect'
import { logPickerCall } from '../platform/opfs'
import { testKeysOpen } from '../platform/testKeys'
import type { HandleRole } from './handleRows'
import { mapRead, storedRead, type ReadWorker, type StoredRead } from './storedRead'

// File handles stored for a chain: in the `handles` store, never on the
// chain record or the journal descriptor, and read only through `handleOf` when a Save, an Export
// or an open's resumed import needs one, never during startup, journal replay or recovery. Two
// cases store no real handle:
// - Under the specs' OPFS picker override: reading a real OPFS handle back from IndexedDB closes
//   Playwright's in-memory Chromium, so the row keeps a token, the file's name in the OPFS root,
//   which any tab finds again; a spec may register fakes under `window.nseTestHandles`.
// - A suspected private window, whose in-memory profile the probe couldn't clear: a missing
//   handle only means a picker.

/** What a record holds in place of a handle under the specs' override. */
export type HandleToken = { testHandle: string }

declare global {
    // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
    interface Window {
        /** Fake or page-held handles by token, under the specs' OPFS picker override. */
        nseTestHandles?: Map<string, FileSystemFileHandle>
    }
}

const isToken = (value: unknown): value is HandleToken =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { testHandle?: unknown }).testHandle === 'string'

const testHandles = (): Map<string, FileSystemFileHandle> => {
    if (typeof window === 'undefined') return new Map()
    return (window.nseTestHandles ??= new Map<string, FileSystemFileHandle>())
}

const probePrivate = async () => {
    try {
        const storage = (globalThis as { navigator?: { storage?: Partial<StorageManager> } })
            .navigator?.storage
        if (!storage?.estimate) return false
        const [{ quota }, persisted] = await Promise.all([
            storage.estimate(),
            storage.persisted ? storage.persisted().catch(() => false) : Promise.resolve(false),
        ])
        return quota !== undefined && suspectPrivate({ persisted, quota })
    } catch {
        return false
    }
}

let probing: Promise<boolean> | undefined
let probed: boolean | undefined

/** Whether this looks like a private window; probed once a page. */
const privateSuspected = () => {
    const forced = platformOverride().privateSuspected
    if (forced !== undefined) return Promise.resolve(forced)
    return (probing ??= probePrivate().then((found) => (probed = found)))
}

/** Runs the private-window check ahead, so Export's synchronous store knows its answer. */
export const checkPrivateWindow = () => {
    void privateSuspected()
}

/** What the `handles` store keeps for a picked handle: the handle, a token, or nothing. */
export const storableHandle = async (
    handle: FileSystemFileHandle | undefined,
): Promise<FileSystemFileHandle | HandleToken | undefined> => {
    if (!handle) return
    // The override's picks are files in the OPFS root, so the name finds one again in any tab.
    if (usesOpfsPickers()) return { testHandle: handle.name }
    return (await privateSuspected()) ? undefined : handle
}

/** `storableHandle` at once: nothing while the private-window check hasn't answered. */
export const storableHandleNow = (
    handle: FileSystemFileHandle | undefined,
): FileSystemFileHandle | HandleToken | undefined => {
    if (!handle) return
    if (usesOpfsPickers()) return { testHandle: handle.name }
    const forced = platformOverride().privateSuspected
    if (forced !== undefined) return forced ? undefined : handle
    checkPrivateWindow()
    return probed === false ? handle : undefined
}

/**
 * Read access to a token's file as a spec sets it: `nse.test.readPermission` 'prompt' answers a
 * query with a prompt and a request with a grant, 'denied' denies the request; each request is
 * logged among the picker calls. Granted otherwise.
 */
const testReadPermission = (name: string, request: boolean): PermissionState => {
    if (!testKeysOpen) return 'granted'
    const set = localStorage.getItem('nse.test.readPermission')
    if (set !== 'prompt' && set !== 'denied') return 'granted'
    if (!request) return 'prompt'
    logPickerCall({ picker: 'permission', mode: 'read', name })
    return set === 'denied' ? 'denied' : 'granted'
}

/** An OPFS root file by name, as a handle each call looks up again (the override's tokens). */
const opfsFile = (name: string): FileSystemFileHandle => {
    const real = async () => (await navigator.storage.getDirectory()).getFileHandle(name)
    const handle = {
        kind: 'file',
        name,
        getFile: async () => (await real()).getFile(),
        createWritable: async (options?: FileSystemCreateWritableOptions) =>
            (await real()).createWritable(options),
        isSameEntry: async (other: FileSystemHandle) => (await real()).isSameEntry(other),
        // A spec's read permission after a reload (`nse.test.readPermission`); writes are granted.
        queryPermission: ({ mode }: { mode?: string } = {}) =>
            Promise.resolve(mode === 'read' ? testReadPermission(name, false) : 'granted'),
        requestPermission: ({ mode }: { mode?: string } = {}) =>
            Promise.resolve(mode === 'read' ? testReadPermission(name, true) : 'granted'),
    }
    return handle as unknown as FileSystemFileHandle
}

/** The handle a stored value stands for; undefined for none, or a token this page doesn't hold. */
export const resolveHandle = (stored: unknown): FileSystemFileHandle | undefined => {
    if (isToken(stored))
        return (
            testHandles().get(stored.testHandle) ??
            (usesOpfsPickers() ? opfsFile(stored.testHandle) : undefined)
        )
    if (typeof stored !== 'object' || stored === null) return
    const handle = stored as Partial<FileSystemFileHandle>
    return typeof handle.getFile === 'function' || typeof handle.isSameEntry === 'function'
        ? (stored as FileSystemFileHandle)
        : undefined
}

/**
 * A chain's stored handle for its binding (`file`) or Export target, read when a Save, an Export
 * or a resumed import needs it. `undefined` is an answer: none is stored, or this page can't hold
 * the stored one. A failed read is `failed`, for each caller to decide (it is never "none").
 */
export const handleOf = async (
    worker: ReadWorker,
    chainId: string,
    role: HandleRole,
): Promise<StoredRead<FileSystemFileHandle | undefined>> =>
    mapRead(await storedRead(worker, 'readHandle', { chainId, role }), resolveHandle)

/** Whether a handle can be read without a prompt: read permission still granted. */
export const readableWithoutPrompt = async (handle: FileSystemFileHandle) => {
    const query = (handle as { queryPermission?: unknown }).queryPermission
    if (typeof query !== 'function') return true
    try {
        return (
            (await (query as (options: { mode: 'read' }) => Promise<PermissionState>).call(handle, {
                mode: 'read',
            })) === 'granted'
        )
    } catch {
        return false
    }
}

/**
 * Asks for read access to a handle: on a press or a dialog opening it made, so the
 * browser can prompt. True when granted.
 */
export const requestRead = async (handle: FileSystemFileHandle) => {
    const request = (handle as { requestPermission?: unknown }).requestPermission
    if (typeof request !== 'function') return true
    try {
        return (
            (await (request as (options: { mode: 'read' }) => Promise<PermissionState>).call(
                handle,
                { mode: 'read' },
            )) === 'granted'
        )
    } catch {
        return false
    }
}
