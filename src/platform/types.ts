// The platform interface (Part 0 §0.9.1). Step 1a implements pickFiles, saveFile for downloads
// and handles, onCloseRequested, onLifecycle, openExternal, fetchServer and diagnostics; Step 1c
// inspect, read and expected for level data; later steps fill the rest.

export type PlatformKind = 'web' | 'native'

export type PlatformOs = 'windows' | 'macos' | 'linux' | 'ios' | 'android' | 'other'

/** What this build and device can do; feature code asks these, never `kind` (Part 0 §0.11.1). */
export type PlatformCapabilities = {
    readonly writeBack: boolean
    readonly unconfirmedDownloads: boolean
    readonly library: boolean
    readonly fileJournal: boolean
    readonly updates: 'none' | 'desktop' | 'store' | 'apk-line'
    readonly defaultAssets: boolean
    readonly browserStorage: boolean
    readonly safeModeEntry: 'query' | 'startMarker'
    readonly fileAssociations: boolean
    readonly mp3Export: boolean
}

/** An app file reference: a path on desktop, a URI on mobile (Part 3). */
export type NativeRef = { path: string } | { uri: string }

export type FileTarget =
    | { kind: 'handle'; handle: FileSystemFileHandle }
    | { kind: 'path'; path: string }
    | { kind: 'uri'; uri: string }

/** What a binding remembers about its file. */
export type DiskState = {
    revisionId?: string
    fingerprint: string
    size: number
    lastModified: number
}

export type PickOptions = {
    /** The picker id, so the browser remembers its folder. */
    id?: string
    /** Keep a file handle where the open picker exists; otherwise a plain file input. */
    handles?: boolean
}

export type OpenedFile = {
    file: File
    handle?: FileSystemFileHandle
    native?: NativeRef
}

/** A source pinned at the changed-on-disk check (Part 1 §1.6.11.7). */
export type PinnedSource = {
    target: FileTarget
    file: Blob
    disk: DiskState
}

/** The shared writer's plan (Part 1 §1.6.11.7); arrives with Step 6. */
export type WritePlan = {
    kind: 'plan'
}

export type FileBody = Blob | WritePlan

export type SaveKind = 'nxsp' | 'nsld' | 'archive' | 'audio' | 'image' | 'recovery'

/** A file type a save picker offers. */
export type SavePickerType = { description: string; extension: string }

/** How a save picker opens, where the browser has one. */
export type SavePicker = {
    /** The picker id, so the browser remembers its folder. */
    id: string
    /** Offered before "All files", the first one selected; none offers "All files" alone. */
    types: SavePickerType[]
}

/** Asks for a new tap once a build has outlasted the gesture; false cancels. */
export type ReadyPrompt = (file: { name: string; size: number }) => Promise<boolean>

export type SaveRequest = {
    kind: SaveKind
    suggestedName: string
    /** Write back here; omitted = ask where (picker or dialog), or download. */
    target?: FileTarget
    /** The precondition: write only if the target still matches. */
    expected?: DiskState | 'absent'
    replaced?: 'keep' | 'discard'
    replaces?: string
    /** Runs after any pick. */
    build: (sources: PinnedSource[]) => Promise<FileBody>
    /** Cancels a pending write before it commits. */
    signal?: AbortSignal
    /** The save picker, when no target is given; level data defaults to today's. */
    picker?: SavePicker
    /** Runs on a picked file before anything is written to it; false writes nothing. */
    picked?: (target: FileTarget) => Promise<boolean>
    /** Asks for the tap a download needs when the build outlasted the gesture. */
    ready?: ReadyPrompt
}

export type SaveResult =
    | { status: 'saved'; target: FileTarget; name: string; disk?: DiskState }
    | { status: 'download-started'; name: string }
    | { status: 'exported'; name: string }
    | { status: 'cancelled' }

export type FileErrorCode = 'conflict' | 'not-found' | 'denied' | 'not-local' | 'no-space' | 'io'

/** Which step failed, where the code alone does not tell the user. */
export type FileErrorStep = 'build' | 'read' | 'readBack' | 'download'

/** How a file operation fails. */
export class FileError extends Error {
    constructor(
        readonly code: FileErrorCode,
        message: string,
        readonly disk?: DiskState,
        readonly step?: FileErrorStep,
    ) {
        super(message)
        this.name = 'FileError'
    }
}

export type LifecycleEvent = 'hide' | 'show' | 'freeze'

export type LockMode = 'exclusive' | 'shared'

/** A lock or a request for one, as navigator.locks.query() lists it. */
export type LockInfo = { name: string; mode: LockMode; clientId?: string }

export type LockSnapshot = { held: LockInfo[]; pending: LockInfo[] }

/** navigator.locks on the web (Step 3). */
export type LockService = {
    /** The callback gets false when ifAvailable finds the lock taken; the lock goes when it settles. */
    request: <T>(
        name: string,
        options: { mode?: LockMode; ifAvailable?: boolean; signal?: AbortSignal },
        callback: (held: boolean) => Promise<T>,
    ) => Promise<T>
    query: () => Promise<LockSnapshot>
}

/** The last-chance journal (Part 1 §1.6.4, §1.6.11.3; Step 3). */
export type JournalStore = {
    keys: () => string[]
    read: (key: string) => string | undefined
    write: (key: string, value: string) => void
    remove: (key: string) => void
}

/** The apps' library (Part 3). */
export type LibraryProvider = {
    list: () => Promise<OpenedFile[]>
}

/** The apps' updater (Part 3, 3.10). */
export type UpdateService = {
    check: () => Promise<boolean>
}

export type ServerFetchInit = Pick<RequestInit, 'method' | 'headers' | 'body' | 'signal'>

/** Copy Diagnostic Info… (Part 1 §1.4.16); Step 1b adds the rest. */
export type DiagnosticInfo = {
    appVersion: string
    engine: string
    os: PlatformOs
    standalone: boolean
    userAgent: string
}

export type Platform = {
    readonly kind: PlatformKind
    readonly os: PlatformOs
    readonly capabilities: PlatformCapabilities

    /** Open File…; [] when cancelled. */
    pickFiles: (opts: PickOptions) => Promise<OpenedFile[]>
    /** Every file the editor writes. */
    saveFile: (req: SaveRequest) => Promise<SaveResult>
    inspect: (target: FileTarget) => Promise<DiskState | 'missing'>
    read: (target: FileTarget) => Promise<Blob>
    onOpenFiles: (handler: (files: OpenedFile[]) => void) => void

    /**
     * beforeunload on the web; the app's own close and quit. The handler answers whether the
     * close may go ahead; the web reads only an answer given synchronously.
     */
    onCloseRequested: (handler: () => boolean | Promise<boolean>) => () => void
    onLifecycle: (handler: (e: LifecycleEvent) => void | Promise<void>) => () => void
    readonly locks: LockService
    readonly journal: JournalStore

    readonly library?: LibraryProvider
    readonly updates?: UpdateService
    openExternal: (url: string) => void
    fetchServer: (url: string, init?: ServerFetchInit) => Promise<Response>
    diagnostics: () => DiagnosticInfo
}
