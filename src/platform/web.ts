import { webLockService } from '../local/locks'
import { allowsFileSystemAccess, detection, isStandalone } from './detect'
import { journalStub, notYet } from './stubs'
import type {
    FileBody,
    LifecycleEvent,
    OpenedFile,
    PickOptions,
    Platform,
    PlatformCapabilities,
    SaveRequest,
    SaveResult,
} from './types'
import { appVersion } from './version'

// Touches no window, navigator or localStorage at import time, so Node tests can resolve it.

// A detached input is otherwise collectable while its picker is open, losing the pick.
const pickingInputs = new Set<HTMLInputElement>()

const pickWithInput = () =>
    new Promise<File | undefined>((resolve) => {
        const input = document.createElement('input')
        input.type = 'file'

        input.onchange = () => {
            pickingInputs.delete(input)
            resolve(input.files?.[0])
        }

        input.oncancel = () => {
            pickingInputs.delete(input)
            resolve(undefined)
        }

        pickingInputs.add(input)
        input.click()
    })

const pickFiles = async ({ id, handles }: PickOptions): Promise<OpenedFile[]> => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!handles || !allowsFileSystemAccess() || !window.showOpenFilePicker) {
        const file = await pickWithInput()
        return file ? [{ file }] : []
    }

    try {
        const [handle] = await window.showOpenFilePicker({ id })
        return [{ file: await handle.getFile(), handle }]
    } catch {
        return []
    }
}

const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError'

/** The save picker for level data; undefined falls back to a download. */
const pickSaveHandle = async (id: string, suggestedName: string) => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!allowsFileSystemAccess() || !window.showSaveFilePicker) return

    try {
        return await window.showSaveFilePicker({ id, suggestedName })
    } catch (error) {
        // Dismissing the picker cancels saving; other failures download instead.
        if (isAbort(error)) throw error
        return
    }
}

const toBlob = (body: FileBody) => {
    if (body instanceof Blob) return body
    throw notYet('Write plans', 'Step 6')
}

const download = (blob: Blob, name: string): SaveResult => {
    // Step 1c replaces this hand-over; synchronous, so the click keeps its user activation.
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = name
    link.rel = 'noopener'
    document.body.append(link)
    link.click()
    link.remove()
    // The browser may still be reading the Blob, so the URL is released later.
    setTimeout(() => {
        URL.revokeObjectURL(url)
    }, 40_000)
    return { status: 'download-started', name }
}

const saveFile = async (req: SaveRequest): Promise<SaveResult> => {
    const { signal } = req
    if (req.expected !== undefined) throw notYet('Save preconditions', 'Step 1c')
    if (req.target && req.target.kind !== 'handle') throw new Error('No file paths on the web')

    // The picker empties the file it returns, so the body is built before it.
    const blob = toBlob(await req.build([]))
    signal?.throwIfAborted()

    let handle = req.target?.handle
    if (!handle && req.kind === 'nsld') {
        try {
            handle = await pickSaveHandle('levelData', req.suggestedName)
        } catch (error) {
            if (isAbort(error)) return { status: 'cancelled' }
            throw error
        }
        signal?.throwIfAborted()
    }

    if (!handle) return download(blob, req.suggestedName)

    let writable: FileSystemWritableFileStream | undefined
    try {
        writable = await handle.createWritable()
        signal?.throwIfAborted()
        await writable.write(blob)
        signal?.throwIfAborted()
        await writable.close()
        signal?.throwIfAborted()

        return { status: 'saved', target: { kind: 'handle', handle }, name: handle.name }
    } catch (error) {
        // Before close(), writes remain pending: release the stream without committing it.
        await writable?.abort().catch(() => undefined)
        signal?.throwIfAborted()
        if (isAbort(error)) throw error
        return download(blob, req.suggestedName)
    }
}

const onCloseRequested = (handler: () => boolean | Promise<boolean>) => {
    const listener = (event: BeforeUnloadEvent) => {
        // beforeunload can't wait: only a synchronous false keeps the page.
        if (handler() === false) event.preventDefault()
    }
    window.addEventListener('beforeunload', listener)
    return () => {
        window.removeEventListener('beforeunload', listener)
    }
}

const onLifecycle = (handler: (e: LifecycleEvent) => void | Promise<void>) => {
    const emit = (e: LifecycleEvent) => void handler(e)
    const onVisibilityChange = () => {
        emit(document.visibilityState === 'hidden' ? 'hide' : 'show')
    }
    const onPageHide = () => {
        emit('hide')
    }
    const onFreeze = () => {
        emit('freeze')
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('pagehide', onPageHide)
    document.addEventListener('freeze', onFreeze)
    return () => {
        document.removeEventListener('visibilitychange', onVisibilityChange)
        window.removeEventListener('pagehide', onPageHide)
        document.removeEventListener('freeze', onFreeze)
    }
}

const openExternal = (url: string) => {
    // Never navigate to a Blob or data: URL from the app.
    if (/^\s*(blob|data):/i.test(url)) throw new Error('Not an external link')
    window.open(url, '_blank', 'noopener')
}

let capabilities: PlatformCapabilities | undefined

const webCapabilities = (): PlatformCapabilities =>
    (capabilities ??= Object.freeze({
        writeBack:
            allowsFileSystemAccess() &&
            typeof window !== 'undefined' &&
            'showSaveFilePicker' in window,
        unconfirmedDownloads: detection().os === 'ios',
        library: false,
        fileJournal: false,
        updates: 'none',
        defaultAssets: true,
        browserStorage: true,
        safeModeEntry: 'query',
        fileAssociations: false,
        mp3Export: true,
    }))

export const platform: Platform = {
    kind: 'web',
    get os() {
        return detection().os
    },
    get capabilities() {
        return webCapabilities()
    },

    pickFiles,
    saveFile,
    inspect: () => Promise.reject(notYet('platform.inspect', 'Step 1c')),
    read: () => Promise.reject(notYet('platform.read', 'Step 1c')),
    // The web registers no file types, so nothing arrives here.
    onOpenFiles: () => undefined,

    onCloseRequested,
    onLifecycle,
    locks: webLockService,
    journal: journalStub,

    openExternal,
    fetchServer: (url, init) => fetch(url, init),
    diagnostics: () => {
        const { engine, os } = detection()
        return {
            appVersion: appVersion().appVersion,
            engine,
            os,
            standalone: isStandalone(),
            userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
        }
    },
}
