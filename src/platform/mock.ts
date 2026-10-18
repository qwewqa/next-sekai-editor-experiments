import { MemoryStorage, storageJournalStore, type JournalStorage } from '../local/journal/store'
import { FakeLockManager } from '../local/testing/locks'
import { levelDataDiskState, nxspDiskState, sameContent } from './fingerprint'
import { toBlob } from './handover'
import {
    FileError,
    type DiagnosticInfo,
    type DiskState,
    type FileTarget,
    type LifecycleEvent,
    type LockService,
    type OpenedFile,
    type PickSaveRequest,
    type PinnedSource,
    type Platform,
    type PlatformCapabilities,
    type PlatformKind,
    type PlatformOs,
    type SaveKind,
    type SaveRequest,
    type SaveResult,
    type ServerFetchInit,
} from './types'

// The in-memory platform for tests, injected with setPlatformForTests. Step 1a covers the 1a
// subset; Step 1c adds inspect, read and expected with level data's sha256 fingerprint; Step 6
// the `.nxsp` revision semantics (the revision id and `<cd>`, Part 0 §0.9.6), pinned sources whose
// reads fail once the file changed, as Chromium's do (§0.9.1), plans, and fault points.

/** Where a write can be interrupted: after its first check, after the build, before `close()`, after it. */
export type MockPoint = 'checked' | 'built' | 'beforeClose' | 'closed'

/** A crash at a fault point: the write stops there, as a killed tab's would. */
export class MockCrash extends Error {
    override name = 'MockCrash'
}

export type MockPlatformOptions = {
    /** The kind it simulates. */
    kind?: PlatformKind
    os?: PlatformOs
    capabilities?: Partial<PlatformCapabilities>
    fetch?: (url: string, init?: ServerFetchInit) => Promise<Response>
    /** A lock client from a shared FakeLockManager, for tests with several tabs. */
    locks?: LockService
    /** The journal's storage; a fresh in-memory one by default. */
    journalStorage?: JournalStorage
}

export type MockPlatform = Platform & {
    /** The in-memory filesystem, by handle name or path. */
    readonly files: Map<string, Blob>
    /** Each file's time, advanced by every write. */
    readonly modified: Map<string, number>
    /** Each pickFiles call takes the next entry; none left is a cancel. */
    readonly picks: OpenedFile[][]
    /**
     * Where each save without a target goes: a target, a cancelled picker, or a download. A save
     * picker alone (`pickSaveFile`) takes the next too, emptying a file that exists (D5).
     */
    readonly saveTargets: (FileTarget | 'cancel' | 'download')[]
    /** Each `pickSaveFile` call's request. */
    readonly pickerCalls: PickSaveRequest[]
    readonly downloads: { kind: SaveRequest['kind']; name: string; blob: Blob }[]
    readonly external: string[]
    /** Calls in order, such as `requestPermission:<name>` and `write:<name>`. */
    readonly calls: string[]
    /** Called just before a write commits, so a test can change the file under it. */
    beforeCommit?: (name: string) => void
    /**
     * A fault at a point of each write: change the file (`writeFile`), throw a `FileError` (a
     * placeholder's `not-local`, `no-space`), or throw `MockCrash` to stop there. A crash before
     * `close()` leaves the file as it was, as the browser's swap file does.
     */
    fault?: (point: MockPoint, name: string) => void | Promise<void>
    /** Each file's version, bumped by every write: a pinned read fails once it moves. */
    readonly versions: Map<string, number>
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
              serverFetch: true,
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
              serverFetch: true,
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
    const journalStorage = options.journalStorage ?? new MemoryStorage()
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

    const versions = new Map<string, number>()

    const writeFile = (name: string, blob: Blob) => {
        files.set(name, blob)
        modified.set(name, (clock += 1000))
        versions.set(name, (versions.get(name) ?? 0) + 1)
    }

    /**
     * The file as `getFile()` gives it: a snapshot whose reads fail with `NotReadableError` once
     * the file changed, as Chromium's do (Part 0 §0.9.1).
     */
    const fileOf = (name: string) => {
        const blob = files.get(name)
        if (!blob) return
        const version = versions.get(name)
        return pinnedFile(blob, name, modified.get(name) ?? 0, () => versions.get(name) === version)
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

    const diskOf = async (
        name: string,
        kind: SaveKind = 'nsld',
        file = fileOf(name),
    ): Promise<DiskState | undefined> => {
        if (!file) return
        return kind === 'nxsp' ? nxspDiskState(file, file.lastModified) : levelDataDiskState(file)
    }

    // The precondition, as the web checks it: content, not time.
    /** The precondition over `file`, the snapshot the write then reads (as the web pins it). */
    const check = async (
        name: string,
        expected: DiskState | 'absent',
        kind: SaveKind,
        file = fileOf(name),
    ) => {
        let disk: DiskState | undefined
        try {
            disk = await diskOf(name, kind, file)
        } catch (error) {
            if (error instanceof DOMException && error.name === 'NotReadableError')
                throw new FileError('conflict', `${name} changed on disk`, await diskOf(name, kind))
            throw error
        }
        if (expected === 'absent') {
            if (disk) throw new FileError('conflict', `${name} exists`, disk)
        } else if (!disk) {
            throw new FileError('not-found', `${name} cannot be found`)
        } else if (!sameContent(disk, expected)) {
            throw new FileError('conflict', `${name} changed on disk`, disk)
        }
        return disk
    }

    const point = async (at: MockPoint, name: string) => {
        await mock.fault?.(at, name)
    }

    // Honours the signal at the same points as the web, in the same order.
    const saveFile = async (req: SaveRequest): Promise<SaveResult> => {
        const { signal, kind } = req
        if (req.target) {
            // The gesture's first call, as on the web.
            const permission =
                req.target.kind === 'handle'
                    ? await (
                          req.target.handle as FileSystemFileHandle & {
                              requestPermission: (d: object) => Promise<PermissionState>
                          }
                      ).requestPermission({ mode: 'readwrite' })
                    : 'granted'
            if (permission !== 'granted') throw new FileError('denied', 'Not allowed')
            const target = req.target
            const write = async () => {
                signal?.throwIfAborted()
                const name = targetKey(target)
                const { expected } = req
                // Source integrity: the File taken at the check is the only source of the old bytes.
                const file = fileOf(name)
                // A write-back's empty target holds nothing to keep (R9): written, with nothing to copy.
                const overEmpty = () =>
                    !!req.overEmpty && kind === 'nxsp' && fileOf(name)?.size === 0
                const emptied = overEmpty()
                const pinned =
                    expected === undefined || emptied
                        ? undefined
                        : await check(name, expected, kind, file)
                signal?.throwIfAborted()
                const sources: PinnedSource[] =
                    pinned && file
                        ? [{ token: 'target', role: 'target', target, file, disk: pinned }]
                        : []
                await point('checked', name)
                let body: Blob
                try {
                    body = await toBlob(await req.build(sources), sources, async () => {
                        const now = await diskOf(name, kind)
                        return now?.fingerprint ?? 'missing'
                    })
                } catch (error) {
                    if (error instanceof DOMException && error.name === 'NotReadableError')
                        throw new FileError(
                            'conflict',
                            `${name} changed on disk`,
                            await diskOf(name, kind),
                        )
                    throw error
                }
                signal?.throwIfAborted()
                await point('built', name)
                mock.beforeCommit?.(name)
                await point('beforeClose', name)
                if (expected !== undefined && !overEmpty()) {
                    // Filled since it was found empty, or changed: never written over unseen.
                    if (emptied)
                        throw new FileError(
                            'conflict',
                            `${name} changed on disk`,
                            await diskOf(name, kind),
                        )
                    const now = await check(name, expected, kind)
                    // Checked again just before close(): a `.nxsp` by the pinned File's fingerprint.
                    if (kind === 'nxsp' && pinned && now?.fingerprint !== pinned.fingerprint)
                        throw new FileError('conflict', `${name} changed on disk`, now)
                }
                signal?.throwIfAborted()
                return commit(target, name, body, kind)
            }
            return req.lock ? req.lock(write) : write()
        }

        // Built before the pick, as the picker empties what it returns (D5).
        const body = await toBlob(await req.build([]))
        signal?.throwIfAborted()
        const target = saveTargets.shift() ?? 'download'
        if (target === 'cancel') return { status: 'cancelled' }
        if (target === 'download') {
            signal?.throwIfAborted()
            downloads.push({ kind: req.kind, name: req.suggestedName, blob: body })
            return { status: 'download-started', name: req.suggestedName }
        }
        const write = async (): Promise<SaveResult> => {
            if (req.picked && !(await req.picked(target))) return { status: 'cancelled' }
            signal?.throwIfAborted()
            // Accepted: written to its end, cancel or not.
            const name = targetKey(target)
            mock.beforeCommit?.(name)
            await point('beforeClose', name)
            return commit(target, name, body, kind)
        }
        return req.lock ? req.lock(write) : write()
    }

    const commit = async (
        target: FileTarget,
        name: string,
        body: Blob,
        kind: SaveKind,
    ): Promise<SaveResult> => {
        calls.push(`write:${name}`)
        writeFile(name, body)
        await point('closed', name)
        return { status: 'saved', target, name, disk: await diskOf(name, kind) }
    }

    const pickerCalls: PickSaveRequest[] = []

    /** A save picker alone: the next target, emptied when it exists, as Chromium's (D5). */
    const pickSaveFile = async (req: PickSaveRequest): Promise<FileTarget | undefined> => {
        pickerCalls.push(req)
        await Promise.resolve()
        const target = saveTargets.shift()
        if (!target || target === 'cancel' || target === 'download') return
        const name = targetKey(target)
        writeFile(name, new Blob([]))
        return target
    }

    const inspect = async (target: FileTarget, kind?: SaveKind): Promise<DiskState | 'missing'> =>
        (await diskOf(targetKey(target), kind)) ?? 'missing'

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
        pickerCalls,
        downloads,
        external,
        calls,
        versions,

        pickFiles: () => Promise.resolve(picks.shift() ?? []),
        saveFile,
        ...(capabilities.writeBack ? { pickSaveFile } : {}),
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
        journal: storageJournalStore(() => journalStorage, 'mock.'),

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

/**
 * A Blob whose reads fail with `NotReadableError` once `current` turns false. A Blob composed from
 * its slices (an executed plan) still reads after a change, where Chromium's fails at `write()`;
 * the check just before `close()` catches that change in both.
 */
class PinnedBlob extends Blob {
    constructor(
        parts: BlobPart[],
        options: BlobPropertyBag,
        private readonly current: () => boolean,
    ) {
        super(parts, options)
    }

    private changed() {
        return this.current()
            ? undefined
            : new DOMException('The file changed after it was read', 'NotReadableError')
    }

    override slice(start?: number, end?: number, type?: string): Blob {
        const changed = this.changed()
        if (changed) throw changed
        return new PinnedBlob([super.slice(start, end, type)], { type: type ?? '' }, this.current)
    }

    override arrayBuffer() {
        const changed = this.changed()
        return changed ? Promise.reject(changed) : super.arrayBuffer()
    }

    override text() {
        const changed = this.changed()
        return changed ? Promise.reject(changed) : super.text()
    }
}

/** A `File` snapshot of `blob` that stops reading once the file changed. */
const pinnedFile = (blob: Blob, name: string, lastModified: number, current: () => boolean) => {
    const pinned = new PinnedBlob([blob], { type: blob.type }, current)
    return Object.assign(pinned, { name, lastModified, webkitRelativePath: '' }) as unknown as File
}
