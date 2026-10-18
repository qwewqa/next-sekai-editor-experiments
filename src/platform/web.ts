import { storageJournalStore } from '../local/journal/store'
import { webLockService } from '../local/locks'
import { storageKey } from '../storage'
import { allowsFileSystemAccess, detection, isStandalone, usesOpfsPickers } from './detect'
import {
    diskStateOf,
    fileErrorOf,
    handOver,
    isAbort,
    requestWrite,
    toBlob,
    verifyBuilt,
    writeHandle,
} from './handover'
import { opfsOpenPicker, opfsSavePicker } from './opfs'
import type {
    DiskState,
    FileTarget,
    LifecycleEvent,
    OpenedFile,
    PickOptions,
    Platform,
    PlatformCapabilities,
    SaveKind,
    SavePicker,
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
    if (
        !handles ||
        !allowsFileSystemAccess() ||
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        (!usesOpfsPickers() && !window.showOpenFilePicker)
    ) {
        const file = await pickWithInput()
        return file ? [{ file }] : []
    }

    try {
        const [handle] = usesOpfsPickers()
            ? await opfsOpenPicker({ id })
            : await window.showOpenFilePicker({ id })
        if (!handle) return []
        return [{ file: await handle.getFile(), handle }]
    } catch {
        return []
    }
}

/** Today's save picker for level data: its folder, and "All files" alone. */
const levelDataPicker: SavePicker = { id: 'levelData', types: [] }

const savePickerOptions = (picker: SavePicker, suggestedName: string): SaveFilePickerOptions => ({
    id: picker.id,
    suggestedName,
    ...(picker.types.length && {
        types: picker.types.map(({ description, extension }) => ({
            description,
            accept: { 'application/octet-stream': [extension as `.${string}`] },
        })),
        excludeAcceptAllOption: false,
    }),
})

/** The save picker; undefined falls back to a download. Dismissing it throws AbortError. */
const pickSaveHandle = async (picker: SavePicker, suggestedName: string) => {
    const options = savePickerOptions(picker, suggestedName)
    if (usesOpfsPickers()) return opfsSavePicker(options)
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!allowsFileSystemAccess() || !window.showSaveFilePicker) return

    try {
        return await window.showSaveFilePicker(options)
    } catch (error) {
        // Dismissing the picker cancels saving; other failures download instead.
        if (isAbort(error)) throw error
        return
    }
}

const saveFile = async (req: SaveRequest): Promise<SaveResult> => {
    // The gesture's first call, before any other await (Part 0 §0.9.1).
    const permission = req.target?.kind === 'handle' ? requestWrite(req.target.handle) : undefined
    const startedAt = performance.now()
    const { signal } = req
    if (req.target && req.target.kind !== 'handle') throw new Error('No file paths on the web')

    if (req.target && permission) {
        // A precondition makes a failure the caller's to show; without one, today's download.
        if (req.expected !== undefined) return writeHandle(req, req.target.handle, permission)
        return writeHandle(req, req.target.handle, permission).catch(async () => {
            signal?.throwIfAborted()
            const blob = await toBlob(await req.build([]))
            await verifyBuilt(req.kind, blob)
            return handOver(blob, req.suggestedName, startedAt, req.ready)
        })
    }

    // The picker empties the file it returns, so the body is built and checked before it (D5).
    const blob = await toBlob(await req.build([]))
    signal?.throwIfAborted()
    await verifyBuilt(req.kind, blob)
    signal?.throwIfAborted()

    let handle: FileSystemFileHandle | undefined
    const picker = req.picker ?? (req.kind === 'nsld' ? levelDataPicker : undefined)
    if (picker) {
        try {
            handle = await pickSaveHandle(picker, req.suggestedName)
        } catch (error) {
            if (isAbort(error)) return { status: 'cancelled' }
            throw error
        }
    }

    if (!handle) {
        signal?.throwIfAborted()
        return handOver(blob, req.suggestedName, startedAt, req.ready)
    }

    // Checked before a cancel is honoured, so a refused file the picker emptied is put back.
    const target: FileTarget = { kind: 'handle', handle }
    if (req.picked && !(await req.picked(target))) return { status: 'cancelled' }
    signal?.throwIfAborted()
    // The user's choice, which the picker emptied (D5): written without a precondition, and to
    // its end once accepted, cancel or not.
    const picked: SaveRequest = {
        ...req,
        target,
        expected: undefined,
        signal: undefined,
        build: () => Promise.resolve(blob),
    }
    try {
        return await writeHandle(picked, handle, requestWrite(handle))
    } catch (error) {
        // A picked file that could not be written is downloaded instead, as today.
        if (req.kind === 'nsld' && !req.picker)
            return handOver(blob, req.suggestedName, startedAt, req.ready)
        throw error
    }
}

const inspect = async (target: FileTarget, kind?: SaveKind): Promise<DiskState | 'missing'> => {
    if (target.kind !== 'handle') throw new Error('No file paths on the web')
    try {
        return await diskStateOf(kind ?? 'nsld', await target.handle.getFile())
    } catch (error) {
        const failure = fileErrorOf(error)
        if (failure.code === 'not-found') return 'missing'
        throw failure
    }
}

const read = async (target: FileTarget): Promise<Blob> => {
    if (target.kind !== 'handle') throw new Error('No file paths on the web')
    try {
        return await target.handle.getFile()
    } catch (error) {
        throw fileErrorOf(error)
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
            usesOpfsPickers() ||
            (allowsFileSystemAccess() &&
                typeof window !== 'undefined' &&
                'showSaveFilePicker' in window),
        unconfirmedDownloads: detection().os === 'ios',
        library: false,
        fileJournal: false,
        updates: 'none',
        defaultAssets: true,
        browserStorage: true,
        safeModeEntry: 'query',
        fileAssociations: false,
        mp3Export: true,
        // The web makes no cross-origin requests.
        serverFetch: false,
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
    inspect,
    read,
    // The web registers no file types, so nothing arrives here.
    onOpenFiles: () => undefined,

    onCloseRequested,
    onLifecycle,
    locks: webLockService,
    // localStorage is read on each call: touched at import time it would break Node tests.
    journal: storageJournalStore(() => localStorage, storageKey('')),

    openExternal,
    fetchServer: () => Promise.reject(new Error('The web build fetches no servers')),
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
