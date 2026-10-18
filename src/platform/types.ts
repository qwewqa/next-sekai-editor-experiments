// The platform interface (Part 0 §0.9.1). Step 1a implements pickFiles, saveFile for downloads
// and handles, onCloseRequested, onLifecycle, openExternal, fetchServer and diagnostics; Step 1c
// inspect, read and expected for level data; Step 6 `.nxsp` revisions, plans and source integrity.

import type { WritePlan } from '../local/nxsp/plan'

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
    /** Browsing and downloading from Sonolus servers (Part 2, 2.5.3): the apps only. */
    readonly serverFetch: boolean
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

/**
 * A source pinned at the changed-on-disk check (Part 0 §0.9.1, source integrity): the `File` the
 * check read, which every later read of the existing file goes through. On the web, Chromium
 * throws `NotReadableError` on reading it once the file changed, which is a `conflict`.
 */
export type PinnedSource = {
    /** Names the source in a plan's copies. */
    token: string
    /** The file being replaced or appended to. */
    role: 'target' | 'base'
    target: FileTarget
    file: Blob
    disk: DiskState
}

/** A `.nxsp` built as a plan for the platform to execute (Part 1 §1.6.11.7). */
export type ZipBody = { kind: 'zip'; plan: WritePlan }

/** What a build returns: a Blob (as `{ kind: 'blob' }` or bare), or a plan. */
export type FileBody = Blob | { kind: 'blob'; blob: Blob } | ZipBody

export type SaveKind = 'nxsp' | 'nsld' | 'archive' | 'audio' | 'image' | 'recovery'

/** A file type a save picker offers. */
export type SavePickerType = { description: string; extension: string }

/** How a save picker opens, where the browser has one. */
export type SavePicker = {
    /** The picker id, so the browser remembers its folder. */
    id: string
    /** Offered before "All files", the first one selected; none offers "All files" alone. */
    types: SavePickerType[]
    /** Leaves "All files" out: the project picker lists `.nxsp` files only (D5). */
    excludeAll?: boolean
    /** Where the picker opens while its id has no folder yet: a folder, or a file's own folder. */
    startIn?: 'documents' | FileSystemHandle
}

/** A save picker alone, for a file built before it (D5). */
export type PickSaveRequest = { suggestedName: string; picker: SavePicker }

/** Asks for a new tap once a build has outlasted the gesture; false cancels. */
export type ReadyPrompt = (file: { name: string; size: number }) => Promise<boolean>

export type SaveRequest = {
    kind: SaveKind
    suggestedName: string
    /** Write back here; omitted = ask where (picker or dialog), or download. */
    target?: FileTarget
    /** The precondition: write only if the target still matches. */
    expected?: DiskState | 'absent'
    /** A `.nxsp` write-back: a target found empty holds nothing to keep, and is written (R9). */
    overEmpty?: boolean
    replaced?: 'keep' | 'discard'
    replaces?: string
    /** Runs after any pick. */
    build: (sources: PinnedSource[]) => Promise<FileBody>
    /** Cancels a pending write before it commits; a pick `picked` accepted is written to its end. */
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

export type FileErrorCode =
    | 'conflict'
    | 'not-found'
    | 'denied'
    | 'not-local'
    | 'no-space'
    /** A read-only file or folder: the browser can't make its swap file (§1.4.7). */
    | 'read-only'
    | 'io'

/** Which step failed, where the code alone does not tell the user. */
export type FileErrorStep = 'build' | 'read' | 'readBack' | 'download' | 'check'

/** How a file operation fails. */
export class FileError extends Error {
    constructor(
        readonly code: FileErrorCode,
        message: string,
        readonly disk?: DiskState,
        readonly step?: FileErrorStep,
        /** The file that failed, where the caller may not know it, as a picked one. */
        readonly fileName?: string,
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

/** A pending journal as found: its session, its text, and where it was (the key without prefix). */
export type JournalFound = { sessionId: string; text: string; from: string }

/** What `writeWhole` needs of a journal; it stores the JSON text of the whole object. */
export type JournalLike = { readonly sessionId: string; readonly seq: number }

/** The last-chance journal (Part 1 §1.6.4, §1.6.11.3), shaped for both platforms. */
export type JournalStore = {
    /**
     * Synchronous; true only when written within the size limits and read back intact. A key
     * holding text this page neither wrote nor loaded is never replaced (§1.6.7).
     */
    writeWhole: (journal: JournalLike) => boolean
    /** Every pending journal. */
    read: () => Promise<JournalFound[]>
    /** Drops this page's journal of a session once a strict committed flush covers its `seq`. */
    clear: (sessionId: string, coveredSeq: number) => void
    /** A journal this page loaded to go on writing (a same-tab reload’s own, §1.6.7). */
    adopt: (found: JournalFound) => void
    /** Whether a session's key still holds the text this page last wrote (or loaded). */
    holds: (sessionId: string) => boolean
    /** Drops a journal once it's applied or kept elsewhere, only if it's still the text found. */
    remove: (found: JournalFound) => void
}

/** The apps' library (Part 3). */
export type LibraryProvider = {
    list: () => Promise<OpenedFile[]>
}

/** The apps' updater (Part 3, 3.10). */
export type UpdateService = {
    check: () => Promise<boolean>
}

export type ServerFetchInit = Pick<
    RequestInit,
    'method' | 'headers' | 'body' | 'signal' | 'credentials' | 'referrerPolicy'
>

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
    /**
     * A save picker alone (owner decision log D5): the picked file, which the picker emptied when
     * it existed, or undefined when dismissed. Any other failure is a `FileError`, never a
     * download (§1.4.7 R12). Absent where there's no save picker.
     */
    pickSaveFile?: (req: PickSaveRequest) => Promise<FileTarget | undefined>
    /** The changed-on-disk check; `nxsp` reads the revision id and `<cd>` (level data by default). */
    inspect: (target: FileTarget, kind?: SaveKind) => Promise<DiskState | 'missing'>
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
