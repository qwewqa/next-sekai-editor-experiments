import { isObject, parseJsonBytes } from '../local/nxsp/json'
import { NXSP_CAPS } from '../local/nxsp/read'
import { zipFingerprint } from '../zip/fingerprint'
import { ZipReader } from '../zip/reader'
import type { DiskState } from './types'

// Fingerprints are pinned text (Part 1 §1.6.11.2): "sha256:<64 hex>" for level data,
// "zip:<size>:<lastModified>:<cd>" for a `.nxsp`, and "damaged:<size>:<lastModified>" for a
// `.nxsp` target that isn't a readable ZIP.

const hex = (bytes: ArrayBuffer) =>
    Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')

/** The sha256 of a Blob's bytes, as lowercase hex. */
export const sha256Hex = async (blob: Blob) =>
    hex(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))

/** A level data file's disk state from bytes already read from it, so no second read differs. */
export const diskStateOfBytes = async (
    bytes: ArrayBuffer,
    lastModified: number,
): Promise<DiskState> => ({
    fingerprint: `sha256:${hex(await crypto.subtle.digest('SHA-256', bytes))}`,
    size: bytes.byteLength,
    lastModified: Math.trunc(lastModified),
})

/** A level data file's disk state: its sha256, size and time. */
export const levelDataDiskState = async (file: File): Promise<DiskState> =>
    diskStateOfBytes(await file.arrayBuffer(), file.lastModified)

/** A read that failed because the file changed after it was taken: never damage (Part 0 §0.9.1). */
export const isNotReadable = (error: unknown) =>
    error instanceof DOMException && error.name === 'NotReadableError'

/**
 * A `.nxsp` file's disk state (§1.6.11.2): its central directory's CRC and `project.json`'s
 * `revision.id`, read from the tail every time. A file that isn't a readable ZIP (a 0-byte file
 * included) gets the `damaged:` fingerprint, which never equals a binding's. A read that fails
 * because the file changed under it (`NotReadableError`) is thrown, never taken for damage.
 */
export const nxspDiskState = async (file: Blob, lastModified: number): Promise<DiskState> => {
    const time = Math.trunc(lastModified)
    const damaged = {
        fingerprint: `damaged:${file.size}:${time}`,
        size: file.size,
        lastModified: time,
    }
    if (!file.size) return damaged
    let fingerprint: string
    try {
        fingerprint = await zipFingerprint(file, time)
    } catch (error) {
        if (isNotReadable(error)) throw error
        return damaged
    }
    let revisionId: string | undefined
    try {
        const reader = await ZipReader.open(file)
        const entry = reader.recovered ? undefined : reader.get('project.json')
        if (entry) {
            const project = parseJsonBytes(await reader.read(entry, { maxSize: NXSP_CAPS.project }))
            const revision = isObject(project) ? project.revision : undefined
            const id = isObject(revision) ? revision.id : undefined
            if (typeof id === 'string' && id) revisionId = id
        }
    } catch (error) {
        if (isNotReadable(error)) throw error
        // A ZIP whose project.json doesn't read has no revision: still not ours.
    }
    return {
        ...(revisionId === undefined ? {} : { revisionId }),
        fingerprint,
        size: file.size,
        lastModified: time,
    }
}

/** A `.nxsp` fingerprint's `<cd>`; undefined for any other fingerprint. */
export const centralDirectoryOf = (fingerprint: string) =>
    /^zip:\d+:-?\d+:([0-9a-f]{8})$/.exec(fingerprint)?.[1]

/**
 * Two disk states describe the same file content. A `.nxsp` compares its revision id and `<cd>`
 * only, so the same bytes with a new time are unchanged (Part 0 §0.9.6); anything else compares
 * its whole fingerprint.
 */
export const sameContent = (a: DiskState, b: DiskState) => {
    if (a.revisionId !== b.revisionId) return false
    const cdA = centralDirectoryOf(a.fingerprint)
    const cdB = centralDirectoryOf(b.fingerprint)
    if (cdA !== undefined || cdB !== undefined) return cdA === cdB
    return a.fingerprint === b.fingerprint
}
