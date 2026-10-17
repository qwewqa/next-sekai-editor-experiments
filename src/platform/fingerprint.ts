import type { DiskState } from './types'

// The level data fingerprint is pinned text (Part 1 §1.6.11.2): "sha256:<64 hex>".

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

/** Two disk states describe the same file content. */
export const sameContent = (a: DiskState, b: DiskState) =>
    a.fingerprint === b.fingerprint && a.revisionId === b.revisionId
