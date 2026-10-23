import { ZipError } from '../../zip/error'
import { ChunkVerifyError, DeflateError, verifyChunk } from '../chunkVerify'
import { fromHex16 } from '../hash'
import { readNxsp, type ReadHistory, type ReportReason } from '../nxsp/read'
import { BATCH_CHUNK_BYTES, BATCH_CHUNKS } from '../open/plan'

// Check File and History…'s file phase (Part 1 §1.4.21): the bound file read in full, as an open
// reads it, then every chunk in `chunks.bin` inflated and hashed with no stored shortcut. Chunks
// are not schema-parsed: one that hashes to its key holds what its writer wrote.

/** The open's reasons that make a bound file damaged. */
const DAMAGE: readonly ReportReason[] = ['damaged', 'history-unreadable', 'media-unreadable']

/** Content this build can't judge: a bound file at its base never has it, so it isn't checked. */
const NEWER: readonly ReportReason[] = [
    'newer-version',
    'newer-minor',
    'newer-level',
    'newer-history',
]

/** A file read for a check; `history` absent when it has none. */
export type FileCheck = { history?: ReadHistory; batches: string[][] }

export type FileCheckOpen =
    /** Damaged as read: no chunk needs checking. */
    | { kind: 'damaged' }
    /** Newer content: the file is not checked (`save.readFailed`). */
    | { kind: 'newer' }
    /** The file could not be read: changed or gone. */
    | { kind: 'readError' }
    /** Read whole; its chunks follow in `batches`, `bytes` stored bytes in all. */
    | { kind: 'read'; check: FileCheck; bytes: number }

/** Whether a read failed on the file itself: Chromium's `NotReadableError` after a change. */
export const isReadError = (error: unknown) =>
    error instanceof DOMException ||
    (error instanceof Error &&
        (error.name === 'NotReadableError' || error.name === 'NotFoundError'))

/** Reads the file as an open does, and plans its chunks in batches by stored bytes. */
export const openFileCheck = async (file: Blob): Promise<FileCheckOpen> => {
    let read
    try {
        read = await readNxsp(file)
    } catch (error) {
        if (isReadError(error)) return { kind: 'readError' }
        throw error
    }
    if (read.kind === 'not-project') return { kind: 'damaged' }
    if (read.report.some(({ reason }) => NEWER.includes(reason))) return { kind: 'newer' }
    if (read.kind === 'unreadable' || read.report.some(({ reason }) => DAMAGE.includes(reason)))
        return { kind: 'damaged' }
    const history = read.history
    const batches: string[][] = []
    let total = 0
    if (history) {
        let batch: string[] = []
        let bytes = 0
        // Every chunk the file holds, reached or not: an append copies them all.
        for (const [hash, { length }] of history.index) {
            if (
                batch.length &&
                (batch.length >= BATCH_CHUNKS || bytes + length > BATCH_CHUNK_BYTES)
            ) {
                batches.push(batch)
                batch = []
                bytes = 0
            }
            batch.push(hash)
            bytes += length
            total += length
        }
        if (batch.length) batches.push(batch)
    }
    return {
        kind: 'read',
        check: { ...(history ? { history } : {}), batches },
        bytes: total,
    }
}

export type FileBatchResult =
    /** The batch's chunks that fail, and its stored bytes for progress. */
    { kind: 'done'; bad: string[]; bytes: number } | { kind: 'readError' }

/** Verifies one batch of the file's chunks: each inflated strictly and hashed to its key. */
export const checkFileChunks = async (
    check: FileCheck,
    n: number,
    tick: () => void = () => undefined,
): Promise<FileBatchResult> => {
    const bad: string[] = []
    let bytes = 0
    const history = check.history
    if (!history) return { kind: 'done', bad, bytes }
    for (const hash of check.batches[n] ?? []) {
        bytes += history.index.get(hash)?.length ?? 0
        try {
            await verifyChunk({ hash: fromHex16(hash), stored: await history.chunks.stored(hash) })
        } catch (error) {
            if (isReadError(error)) return { kind: 'readError' }
            if (
                !(error instanceof ChunkVerifyError) &&
                !(error instanceof DeflateError) &&
                !(error instanceof ZipError)
            )
                throw error
            bad.push(hash)
        }
        tick()
    }
    return { kind: 'done', bad, bytes }
}
