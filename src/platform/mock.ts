import { FakeLockManager } from '../local/testing/locks'
import { journalStub, notYet } from './stubs'
import type {
    DiagnosticInfo,
    FileTarget,
    LifecycleEvent,
    LockService,
    OpenedFile,
    Platform,
    PlatformCapabilities,
    PlatformKind,
    PlatformOs,
    SaveRequest,
    SaveResult,
    ServerFetchInit,
} from './types'

// The in-memory platform for tests, injected with setPlatformForTests. Step 1a covers the 1a
// subset; Step 1c adds inspect, read and expected, and Step 6 revision semantics and faults.

export type MockPlatformOptions = {
    /** The kind it simulates. */
    kind?: PlatformKind
    os?: PlatformOs
    capabilities?: Partial<PlatformCapabilities>
    fetch?: (url: string, init?: ServerFetchInit) => Promise<Response>
    /** A lock client from a shared FakeLockManager, for tests with several tabs. */
    locks?: LockService
}

export type MockPlatform = Platform & {
    /** The in-memory filesystem, by handle name or path. */
    readonly files: Map<string, Blob>
    /** Each pickFiles call takes the next entry; none left is a cancel. */
    readonly picks: OpenedFile[][]
    /** Where each save without a target goes: a target, a cancelled picker, or a download. */
    readonly saveTargets: (FileTarget | 'cancel' | 'download')[]
    readonly downloads: { kind: SaveRequest['kind']; name: string; blob: Blob }[]
    readonly external: string[]
    /** Asks every close handler, as closing the tab or window does; true when all allow it. */
    requestClose: () => Promise<boolean>
    emitLifecycle: (e: LifecycleEvent) => Promise<void>
    /** A handle whose writes land in files. */
    createHandle: (name: string) => FileSystemFileHandle
}

const defaults = (kind: PlatformKind): PlatformCapabilities =>
    kind === 'web'
        ? {
              writeBack: true,
              unconfirmedDownloads: false,
              library: false,
              fileJournal: false,
              updates: 'none',
              defaultAssets: true,
              browserStorage: true,
              safeModeEntry: 'query',
              fileAssociations: false,
              mp3Export: true,
          }
        : {
              writeBack: true,
              unconfirmedDownloads: false,
              library: true,
              fileJournal: true,
              updates: 'desktop',
              defaultAssets: false,
              browserStorage: false,
              safeModeEntry: 'startMarker',
              fileAssociations: true,
              mp3Export: true,
          }

const targetKey = (target: FileTarget) => {
    switch (target.kind) {
        case 'handle':
            return target.handle.name
        case 'path':
            return target.path
        case 'uri':
            return target.uri
    }
}

/** This mock's own FIFO lock manager, as one tab sees it. */
const mockLocks = () => {
    const manager = new FakeLockManager()
    return manager.client(manager.scheduler.main)
}

export const createMockPlatform = (options: MockPlatformOptions = {}): MockPlatform => {
    const kind = options.kind ?? 'web'
    const os = options.os ?? 'windows'
    const capabilities = Object.freeze({ ...defaults(kind), ...options.capabilities })
    const files = new Map<string, Blob>()
    const picks: OpenedFile[][] = []
    const saveTargets: (FileTarget | 'cancel' | 'download')[] = []
    const downloads: MockPlatform['downloads'] = []
    const external: string[] = []
    const closeHandlers = new Set<() => boolean | Promise<boolean>>()
    const lifecycleHandlers = new Set<(e: LifecycleEvent) => void | Promise<void>>()

    const createHandle = (name: string) =>
        ({
            kind: 'file',
            name,
            getFile: () => {
                const blob = files.get(name)
                if (!blob) return Promise.reject(new DOMException('Not found', 'NotFoundError'))
                return Promise.resolve(new File([blob], name, { type: blob.type }))
            },
            createWritable: () => {
                const parts: Blob[] = []
                return Promise.resolve({
                    write: (data: Blob) => {
                        parts.push(data)
                        return Promise.resolve()
                    },
                    close: () => {
                        files.set(name, new Blob(parts))
                        return Promise.resolve()
                    },
                    abort: () => Promise.resolve(),
                })
            },
        }) as unknown as FileSystemFileHandle

    const saveFile = async (req: SaveRequest): Promise<SaveResult> => {
        if (req.expected !== undefined) throw notYet('Save preconditions', 'Step 1c')
        const target = req.target ?? saveTargets.shift() ?? 'download'
        if (target === 'cancel') return { status: 'cancelled' }
        req.signal?.throwIfAborted()

        const body = await req.build([])
        if (!(body instanceof Blob)) throw notYet('Write plans', 'Step 6')
        req.signal?.throwIfAborted()

        if (target === 'download') {
            downloads.push({ kind: req.kind, name: req.suggestedName, blob: body })
            return { status: 'download-started', name: req.suggestedName }
        }
        const name = targetKey(target)
        files.set(name, body)
        return { status: 'saved', target, name }
    }

    const diagnostics = (): DiagnosticInfo => ({
        appVersion: '0.0.0',
        engine: 'other',
        os,
        standalone: false,
        userAgent: 'mock',
    })

    return {
        kind,
        os,
        capabilities,
        files,
        picks,
        saveTargets,
        downloads,
        external,

        pickFiles: () => Promise.resolve(picks.shift() ?? []),
        saveFile,
        inspect: () => Promise.reject(notYet('platform.inspect', 'Step 1c')),
        read: () => Promise.reject(notYet('platform.read', 'Step 1c')),
        onOpenFiles: () => undefined,

        onCloseRequested: (handler) => {
            closeHandlers.add(handler)
            return () => closeHandlers.delete(handler)
        },
        onLifecycle: (handler) => {
            lifecycleHandlers.add(handler)
            return () => lifecycleHandlers.delete(handler)
        },
        locks: options.locks ?? mockLocks(),
        journal: journalStub,

        openExternal: (url) => {
            external.push(url)
        },
        fetchServer: (url, init) =>
            options.fetch
                ? options.fetch(url, init)
                : Promise.reject(new TypeError('No server in the mock')),
        diagnostics,

        requestClose: async () => {
            let allowed = true
            for (const handler of [...closeHandlers]) if (!(await handler())) allowed = false
            return allowed
        },
        emitLifecycle: async (e) => {
            for (const handler of [...lifecycleHandlers]) await handler(e)
        },
        createHandle,
    }
}
