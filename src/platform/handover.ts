import { ungzip } from 'pako'
import { ExecutionError, executePlan, type ExecutionSource } from '../local/nxsp/execute'
import { detection, hasActivation, isStandalone, reportsActivation } from './detect'
import { levelDataDiskState, nxspDiskState, sameContent, sha256Hex } from './fingerprint'
import { savePoint } from './testPause'
import {
    FileError,
    type DiskState,
    type FileBody,
    type FileErrorCode,
    type FileTarget,
    type PinnedSource,
    type ReadyPrompt,
    type SaveRequest,
    type SaveResult,
} from './types'

// The hand-over (Part 1 §1.5.6): every file the web writes goes through here, behind saveFile.

/** Below this a data: URL is a usable last resort; browsers cap or block larger ones. */
export const DATA_URL_LIMIT = 1024 * 1024

/** Without navigator.userActivation, a build longer than this may have outlasted the gesture. */
const GESTURE_MS = 1000

export const isAbort = (error: unknown) =>
    error instanceof DOMException && error.name === 'AbortError'

const errorName = (error: unknown) => (error instanceof DOMException ? error.name : undefined)

// The code each DOMException becomes; a denial is never "not found".
const codes: Partial<Record<string, FileErrorCode>> = {
    NotFoundError: 'not-found',
    NotAllowedError: 'denied',
    SecurityError: 'denied',
    // The file changed after it was read (Part 0 §0.9.1).
    NotReadableError: 'conflict',
    QuotaExceededError: 'no-space',
    NoModificationAllowedError: 'read-only',
}

/** A failed file operation as a FileError. */
export const fileErrorOf = (error: unknown, disk?: DiskState): FileError => {
    if (error instanceof FileError) return error
    const message = error instanceof Error ? error.message : String(error)
    const code = codes[errorName(error) ?? ''] ?? 'io'
    return new FileError(code, message, code === 'conflict' ? disk : undefined)
}

const isBlob = (body: FileBody): body is Blob => body instanceof Blob

/**
 * A build's file as a Blob: a Blob as it is, or a plan executed over the pinned sources (Part 1
 * §1.6.11.7). A copy that fails with its source changed is a `conflict`; any other failure is `io`.
 */
export const toBlob = async (
    body: FileBody,
    sources: readonly PinnedSource[] = [],
    readAgain?: (source: PinnedSource) => Promise<string>,
): Promise<Blob> => {
    if (isBlob(body)) return body
    if (body.kind === 'blob') return body.blob
    const executing = new Map<string, ExecutionSource>()
    for (const source of sources)
        executing.set(source.token, {
            file: source.file,
            fingerprint: source.disk.fingerprint,
            role: source.role,
            readFingerprint: () =>
                readAgain ? readAgain(source) : Promise.resolve(source.disk.fingerprint),
        })
    try {
        return await executePlan(body.plan, executing)
    } catch (error) {
        if (error instanceof ExecutionError) {
            if (error.code === 'conflict') throw new FileError('conflict', error.message)
            throw new FileError('io', error.message, undefined, 'build')
        }
        throw error
    }
}

/** Built level data is gunzipped and parsed before it is handed over or written. */
export const verifyBuilt = async (kind: SaveRequest['kind'], blob: Blob) => {
    if (kind !== 'nsld') return
    let parsed: unknown
    try {
        parsed = JSON.parse(
            new TextDecoder().decode(ungzip(new Uint8Array(await blob.arrayBuffer()))),
        )
    } catch {
        parsed = undefined
    }
    const entities = (parsed as { entities?: unknown } | undefined)?.entities
    if (!Array.isArray(entities))
        throw new FileError('io', 'The built level data did not verify', undefined, 'build')
}

type PermissionHandle = FileSystemFileHandle & {
    requestPermission?: (descriptor: { mode: 'readwrite' }) => Promise<PermissionState>
}

/**
 * Asks for write access. Called first on the gesture, before any other await (Part 0 §0.9.1);
 * it resolves at once when access is already granted.
 */
export const requestWrite = (handle: FileSystemFileHandle): Promise<PermissionState> => {
    const request = (handle as PermissionHandle).requestPermission
    // Only Chromium hands out handles, and it has requestPermission; a handle without it is granted.
    if (typeof request !== 'function') return Promise.resolve('granted')
    try {
        return request.call(handle, { mode: 'readwrite' })
    } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
}

/** A file's disk state by its kind: a `.nxsp` by revision id and `<cd>`, anything else by sha256. */
export const diskStateOf = (kind: SaveRequest['kind'], file: File) =>
    kind === 'nxsp' ? nxspDiskState(file, file.lastModified) : levelDataDiskState(file)

type Found = { file: File; disk: DiskState | undefined } | undefined

/**
 * The file as it is now, measured against `expected`: for level data `disk` is undefined when
 * the file differs in size or exists where none should, since a change needs no hash and a large
 * file no read; a `.nxsp` always reads its revision id and `<cd>` (Part 0 §0.9.6).
 */
const readDisk = async (
    kind: SaveRequest['kind'],
    handle: FileSystemFileHandle,
    expected: DiskState | 'absent',
): Promise<Found> => {
    try {
        const file = await handle.getFile()
        if (expected === 'absent') return { file, disk: undefined }
        if (kind !== 'nxsp' && file.size !== expected.size) return { file, disk: undefined }
        return { file, disk: await diskStateOf(kind, file) }
    } catch (error) {
        if (errorName(error) === 'NotFoundError') return
        throw fileErrorOf(error)
    }
}

/** Whether the file found still matches `expected`. */
const matches = (found: Found, expected: DiskState | 'absent'): boolean =>
    expected === 'absent' ? !found : !!found?.disk && sameContent(found.disk, expected)

const changedError = (
    handle: FileSystemFileHandle,
    found: Found,
    expected: DiskState | 'absent',
) => {
    if (!found) return new FileError('not-found', `${handle.name} cannot be found`)
    const message =
        expected === 'absent' ? `${handle.name} exists` : `${handle.name} changed on disk`
    return new FileError('conflict', message, found.disk)
}

/** The file's fingerprint now, through a new `getFile()`: a change after pinning is a conflict. */
const fingerprintNow = async (kind: SaveRequest['kind'], handle: FileSystemFileHandle) => {
    try {
        return (await diskStateOf(kind, await handle.getFile())).fingerprint
    } catch {
        // Gone or unreadable: changed, the safe side.
        return 'changed'
    }
}

const writeTo = async (
    req: SaveRequest,
    handle: FileSystemFileHandle,
    permission: Promise<PermissionState>,
): Promise<SaveResult & { status: 'saved' }> => {
    const { signal, expected, kind } = req
    const target: FileTarget = { kind: 'handle', handle }
    let state: PermissionState
    try {
        state = await permission
    } catch (error) {
        throw fileErrorOf(error)
    }
    if (state !== 'granted')
        throw new FileError('denied', `Writing to ${handle.name} was not allowed`)
    signal?.throwIfAborted()

    // Source integrity (Part 0 §0.9.1): everything the write reads of the existing file comes
    // from the File taken at this check.
    const sources: PinnedSource[] = []
    let pinned: DiskState | undefined
    if (expected !== undefined) {
        const found = await readDisk(kind, handle, expected)
        signal?.throwIfAborted()
        if (!matches(found, expected)) throw changedError(handle, found, expected)
        if (found?.disk) {
            pinned = found.disk
            sources.push({
                token: 'target',
                role: 'target',
                target,
                file: found.file,
                disk: found.disk,
            })
        }
    }

    let blob: Blob
    let written: string
    try {
        blob = await toBlob(await req.build(sources), sources, () => fingerprintNow(kind, handle))
        signal?.throwIfAborted()
        // The built Blob can hold ranges of the pinned file, read again here.
        await verifyBuilt(kind, blob)
        written = await sha256Hex(blob)
    } catch (error) {
        // Reading the pinned file failed: it changed after the check.
        if (errorName(error) === 'NotReadableError') throw fileErrorOf(error, pinned)
        throw error
    }
    signal?.throwIfAborted()

    let writable: FileSystemWritableFileStream | undefined
    try {
        writable = await handle.createWritable()
        signal?.throwIfAborted()
        await writable.write(blob)
        signal?.throwIfAborted()
        await savePoint('beforeClose')
        if (expected !== undefined) {
            // Checked again just before the commit (Part 0 §0.9.6); a `.nxsp` by the whole
            // fingerprint of the File pinned at the first check, so a change during the build or
            // the write is never overwritten unseen.
            const found = await readDisk(kind, handle, expected)
            signal?.throwIfAborted()
            if (!matches(found, expected)) throw changedError(handle, found, expected)
            if (kind === 'nxsp' && pinned && found?.disk?.fingerprint !== pinned.fingerprint)
                throw new FileError('conflict', `${handle.name} changed on disk`, found?.disk)
        }
        await writable.close()
        writable = undefined
    } catch (error) {
        // Before close(), writes remain pending: release the stream without committing it.
        await writable?.abort().catch(() => undefined)
        signal?.throwIfAborted()
        // An AbortError with no cancel, as a browser's block on close(), is a failure.
        throw fileErrorOf(error)
    }

    // The read-back: `saved` means the file holds exactly the bytes built.
    let disk: DiskState
    try {
        const file = await handle.getFile()
        disk = await levelDataDiskState(file)
        if (kind === 'nxsp' && disk.fingerprint === `sha256:${written}`)
            disk = await nxspDiskState(file, file.lastModified)
    } catch (error) {
        throw fileErrorOf(error)
    }
    if (
        kind === 'nxsp'
            ? !disk.fingerprint.startsWith('zip:')
            : disk.fingerprint !== `sha256:${written}`
    )
        throw new FileError(
            'io',
            `${handle.name} did not read back as written`,
            undefined,
            'readBack',
        )
    return { status: 'saved', target, name: handle.name, disk }
}

/**
 * Writes through a handle. With `expected`, the file is checked first, and again just before
 * `close()`; a change aborts the write, leaving the target untouched. Then the file is read
 * back and its sha256 compared, so `saved` means verified. A failure names the handle's file.
 */
export const writeHandle = async (
    req: SaveRequest,
    handle: FileSystemFileHandle,
    permission: Promise<PermissionState>,
) => {
    try {
        return await writeTo(req, handle, permission)
    } catch (error) {
        if (!(error instanceof FileError) || error.fileName !== undefined) throw error
        throw new FileError(error.code, error.message, error.disk, error.step, handle.name)
    }
}

// Downloads.

/** Where a Blob link whose download WebKit ignores would replace the page: iOS, a Home Screen app. */
const mayNavigateOnDownload = () => detection().os === 'ios' || isStandalone()

const anchorDownloads = () =>
    typeof HTMLAnchorElement === 'undefined' || 'download' in HTMLAnchorElement.prototype

const clickLink = (href: string, name: string, newContext: boolean) => {
    const link = document.createElement('a')
    link.href = href
    link.download = name
    link.rel = 'noopener'
    // Never this browsing context: an ignored download opens a new one (§1.5.6).
    if (newContext) link.target = '_blank'
    document.body.append(link)
    link.click()
    link.remove()
}

const dataUrlOf = async (blob: Blob) => {
    const bytes = new Uint8Array(await blob.arrayBuffer())
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000)
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return `data:application/octet-stream;base64,${btoa(binary)}`
}

/** How long a download's Blob URL is kept: iOS may ask "Download?" long after the tap. */
const BLOB_URL_MS = 10 * 60_000

const blobUrls = new Set<string>()
let releasesOnHide = false

const release = (url: string) => {
    if (blobUrls.delete(url)) URL.revokeObjectURL(url)
}

/** A Blob URL kept until the page hides, or for BLOB_URL_MS. */
const keptBlobUrl = (blob: Blob) => {
    const url = URL.createObjectURL(blob)
    blobUrls.add(url)
    setTimeout(() => {
        release(url)
    }, BLOB_URL_MS)
    if (!releasesOnHide) {
        releasesOnHide = true
        window.addEventListener('pagehide', () => {
            for (const kept of [...blobUrls]) release(kept)
        })
    }
    return url
}

/**
 * Hands a Blob to the browser: an anchor download, else a new context with window.open,
 * else a data: URL below 1 MB. Never navigates the app's own context. Synchronous once
 * the data: URL, when one may be needed, is ready, so the tap keeps its activation.
 * False when no path was taken.
 */
const startDownload = (blob: Blob, name: string, dataUrl: string | undefined) => {
    const url = keptBlobUrl(blob)
    if (anchorDownloads()) {
        clickLink(url, name, mayNavigateOnDownload())
        return true
    }
    if (window.open(url, '_blank')) return true
    if (!dataUrl) return false
    // Anchors here ignore download, so the link always opens a new context.
    clickLink(dataUrl, name, true)
    return true
}

/**
 * Downloads a built file as application/octet-stream. When the build outlasted the gesture,
 * `ready` asks for a new tap first.
 */
export const handOver = async (
    blob: Blob,
    name: string,
    startedAt: number,
    ready: ReadyPrompt | undefined,
): Promise<SaveResult> => {
    // Never application/zip, which Safari may rename to .zip.
    const file =
        blob.type === 'application/octet-stream'
            ? blob
            : new Blob([blob], { type: 'application/octet-stream' })
    const dataUrl =
        !anchorDownloads() && file.size < DATA_URL_LIMIT ? await dataUrlOf(file) : undefined
    const expired = reportsActivation()
        ? !hasActivation()
        : performance.now() - startedAt > GESTURE_MS
    if (expired && ready && !(await ready({ name, size: file.size })))
        return { status: 'cancelled' }
    if (!startDownload(file, name, dataUrl))
        throw new FileError('io', `${name} could not be downloaded`, undefined, 'download', name)
    return { status: 'download-started', name }
}
