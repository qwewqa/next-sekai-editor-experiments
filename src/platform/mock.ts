import { FakeLockManager } from '../local/testing/locks'
import { levelDataDiskState, sameContent } from './fingerprint'
import { journalStub, notYet } from './stubs'
import {
    FileError,
    type DiagnosticInfo,
    type DiskState,
    type FileTarget,
    type LifecycleEvent,
    type LockService,
    type OpenedFile,
    type Platform,
    type PlatformCapabilities,
    type PlatformKind,
    type PlatformOs,
    type SaveRequest,
    type SaveResult,
    type ServerFetchInit,
} from './types'

// The in-memory platform for tests, injected with setPlatformForTests. Step 1a covers the 1a
// subset; Step 1c adds inspect, read and expected with level data's sha256 fingerprint, and
// Step 6 revision semantics and faults.

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
    /** Each file's time, advanced by every write. */
    readonly modified: Map<string, number>
    /** Each pickFiles call takes the next entry; none left is a cancel. */
    readonly picks: OpenedFile[][]
    /** Where each save without a target goes: a target, a cancelled picker, or a download. */
    readonly saveTargets: (FileTarget | 'cancel' | 'download')[]
    readonly downloads: { kind: SaveRequest['kind']; name: string; blob: Blob }[]
    readonly external: string[]
    /** Calls in order, such as `requestPermission:<name>` and `write:<name>`. */
    readonly calls: string[]
    /** Called just before a write commits, so a test can change the file under it. */
    beforeCommit?: (name: string) => void
    /** Asks every close handler, as closing the tab or window does; true when all allow it. */
    requestClose: () => Promise<boolean>
    emitLifecycle: (e: LifecycleEvent) => Promise<void>
    /** A handle whose writes land in files. */
    createHandle: (name: string, options?: MockHandleOptions) => FileSystemFileHandle
    /** Writes a file as another program would. */
    writeFile: (name: string, blob: Blob) => void
}

export type MockHandleOptions = {
    /** What requestPermission answers, asked on each call; granted by default. */
    permission?: () => PermissionState
    /** Read when requestPermission is called, as the gesture's activation; recorded in the call. */
    activation?: () => boolean
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
    const modified = new Map<string, number>()
    const picks: OpenedFile[][] = []
    const saveTargets: (FileTarget | 'cancel' | 'download')[] = []
    const downloads: MockPlatform['downloads'] = []
    const external: string[] = []
    const calls: string[] = []
    const closeHandlers = new Set<() => boolean | Promise<boolean>>()
    const lifecycleHandlers = new Set<(e: LifecycleEvent) => void | Promise<void>>()
    let clock = 1_700_000_000_000

    const writeFile = (name: string, blob: Blob) => {
        files.set(name, blob)
        modified.set(name, (clock += 1000))
    }

    const fileOf = (name: string) => {
        const blob = files.get(name)
        return blob && new File([blob], name, { type: blob.type, lastModified: modified.get(name) })
    }

    const createHandle = (name: string, options: MockHandleOptions = {}): FileSystemFileHandle => {
        const handle = {
            kind: 'file',
            name,
            requestPermission: () => {
                const { activation, permission } = options
                const active = activation ? `:${activation() ? 'active' : 'expired'}` : ''
                calls.push(`requestPermission:${name}${active}`)
                return Promise.resolve(permission?.() ?? 'granted')
            },
            isSameEntry: (other: FileSystemHandle) => Promise.resolve(other.name === name),
            getFile: () => {
                const file = fileOf(name)
                if (!file) return Promise.reject(new DOMException('Not found', 'NotFoundError'))
                return Promise.resolve(file)
            },
            createWritable: () => {
                const parts: Blob[] = []
                return Promise.resolve({
                    write: (data: Blob) => {
                        parts.push(data)
                        return Promise.resolve()
                    },
                    close: () => {
                        calls.push(`write:${name}`)
                        writeFile(name, new Blob(parts))
                        return Promise.resolve()
                    },
                    abort: () => Promise.resolve(),
                })
            },
        }
        return handle as unknown as FileSystemFileHandle
    }

    const diskOf = async (name: string): Promise<DiskState | undefined> => {
        const file = fileOf(name)
        return file && (await levelDataDiskState(file))
    }

    // The precondition, as the web checks it: content, not time.
    const check = async (name: string, expected: DiskState | 'absent') => {
        const disk = await diskOf(name)
        if (expected === 'absent') {
            if (disk) throw new FileError('conflict', `${name} exists`, disk)
        } else if (!disk) {
            throw new FileError('not-found', `${name} cannot be found`)
        } else if (!sameContent(disk, expected)) {
            throw new FileError('conflict', `${name} changed on disk`, disk)
        }
        return disk
    }

    const saveFile = async (req: SaveRequest): Promise<SaveResult> => {
        // The gesture's first call, as on the web.
        const permission =
            req.target?.kind === 'handle'
                ? (
                      req.target.handle as FileSystemFileHandle & {
                          requestPermission: (d: object) => Promise<PermissionState>
                      }
                  ).requestPermission({ mode: 'readwrite' })
                : undefined
        if (permission && (await permission) !== 'granted')
            throw new FileError('denied', 'Not allowed')
        const target = req.target ?? saveTargets.shift() ?? 'download'
        if (target === 'cancel') return { status: 'cancelled' }
        req.signal?.throwIfAborted()

        const expected = req.target ? req.expected : undefined
        const name = target === 'download' ? req.suggestedName : targetKey(target)
        const pinned = expected === undefined ? undefined : await check(name, expected)
        const file = pinned && fileOf(name)
        const body = await req.build(
            pinned && file && target !== 'download' ? [{ target, file, disk: pinned }] : [],
        )
        if (!(body instanceof Blob)) throw notYet('Write plans', 'Step 6')
        req.signal?.throwIfAborted()

        if (target === 'download') {
            downloads.push({ kind: req.kind, name: req.suggestedName, blob: body })
            return { status: 'download-started', name: req.suggestedName }
        }
        if (!req.target && req.picked && !(await req.picked(target))) return { status: 'cancelled' }
        mock.beforeCommit?.(name)
        if (expected !== undefined) await check(name, expected)
        calls.push(`write:${name}`)
        writeFile(name, body)
        return { status: 'saved', target, name, disk: await diskOf(name) }
    }

    const inspect = async (target: FileTarget): Promise<DiskState | 'missing'> =>
        (await diskOf(targetKey(target))) ?? 'missing'

    const read = (target: FileTarget): Promise<Blob> => {
        const file = fileOf(targetKey(target))
        if (!file) return Promise.reject(new FileError('not-found', 'Not found'))
        return Promise.resolve(file)
    }

    const diagnostics = (): DiagnosticInfo => ({
        appVersion: '0.0.0',
        engine: 'other',
        os,
        standalone: false,
        userAgent: 'mock',
    })

    const mock: MockPlatform = {
        kind,
        os,
        capabilities,
        files,
        modified,
        picks,
        saveTargets,
        downloads,
        external,
        calls,

        pickFiles: () => Promise.resolve(picks.shift() ?? []),
        saveFile,
        inspect,
        read,
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
        writeFile,
    }
    return mock
}
