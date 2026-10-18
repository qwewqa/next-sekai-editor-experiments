import { platformOverride, suspectPrivate, usesOpfsPickers } from '../platform/detect'

// File handles stored on a chain record (Part 1 §1.3.2, D16). A stored handle is used only when a
// Save, an Export or an open's resumed import needs it, never during startup, journal replay or
// recovery. Two cases keep a handle off the record:
// - Under the specs' OPFS picker override: reading a real OPFS handle back from IndexedDB closes
//   Playwright's in-memory Chromium, so the record keeps a token, the file's name in the OPFS
//   root, which any tab finds again; a spec may register fakes under `window.nseTestHandles`.
// - A suspected private window, whose in-memory profile the D16 probe couldn't clear: a missing
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

const privateSuspected = async () => {
    const forced = platformOverride().privateSuspected
    if (forced !== undefined) return forced
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

/** What a chain record stores for a picked handle: the handle, a token, or nothing. */
export const storableHandle = async (
    handle: FileSystemFileHandle | undefined,
): Promise<FileSystemFileHandle | HandleToken | undefined> => {
    if (!handle) return
    // The override's picks are files in the OPFS root, so the name finds one again in any tab.
    if (usesOpfsPickers()) return { testHandle: handle.name }
    return (await privateSuspected()) ? undefined : handle
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
        queryPermission: () => Promise.resolve('granted'),
        requestPermission: () => Promise.resolve('granted'),
    }
    return handle as unknown as FileSystemFileHandle
}

/** The handle a stored value stands for; undefined for none, or a token this page doesn't hold. */
export const handleOf = (stored: unknown): FileSystemFileHandle | undefined => {
    if (isToken(stored))
        return (
            testHandles().get(stored.testHandle) ??
            (usesOpfsPickers() ? opfsFile(stored.testHandle) : undefined)
        )
    if (typeof stored !== 'object' || stored === null) return
    const handle = stored as Partial<FileSystemFileHandle>
    return typeof handle.getFile === 'function' ? (stored as FileSystemFileHandle) : undefined
}

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
