import { crc32 } from '../../zip/crc32'
import { LOCAL_HEADER_SIZE, localHeaderSize } from '../../zip/directory'
import { ZipError } from '../../zip/error'
import { inflateExact } from '../../zip/inflate'
import { ZipReader } from '../../zip/reader'
import { assembleZip, type PreparedEntry } from '../../zip/writer'
import { ENTRY_LIMIT, ZIP32_LIMIT, type PlannedEntry, type WritePlan } from './plan'

// The executor (§1.6.11.7): it follows a plan exactly. Every copy reads through the pinned source
// its token names, by central-directory index and `dataOffset`, and is checked by the entry's CRC;
// the CRC and sizes of what it writes are computed, never trusted; a plan that breaks the contract
// is a plan error, a copy that fails is damage in its source, or a conflict when the source changed.

/** A source the executor reads: the pinned file, its fingerprint then, and how to read it again. */
export type ExecutionSource = {
    file: Blob
    fingerprint: string
    role: 'target' | 'base'
    /** The file's fingerprint now; a change after pinning is a conflict. */
    readFingerprint: () => Promise<string>
}

export type ExecutionErrorCode = 'io' | 'conflict' | 'plan'

/**
 * A plan that failed: `plan` for a plan that breaks the contract (a bug, written as `io`), `io` for
 * damage in a source (with its token and role), `conflict` when a source changed after pinning.
 */
export class ExecutionError extends Error {
    override name = 'ExecutionError'
    constructor(
        readonly code: ExecutionErrorCode,
        message: string,
        readonly source?: { token: string; role: 'target' | 'base' },
    ) {
        super(message)
    }
}

const planError = (message: string): never => {
    throw new ExecutionError('plan', message)
}

type OpenSource = { token: string; source: ExecutionSource; reader: ZipReader }

const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer())

/**
 * Runs a plan and returns the file. Nothing is written by a plan that fails: the caller gets an
 * `ExecutionError` and no Blob.
 */
export const executePlan = async (
    plan: WritePlan,
    sources: ReadonlyMap<string, ExecutionSource>,
): Promise<Blob> => {
    const open = new Map<string, OpenSource>()
    const sourceFor = async (token: string) => {
        const known = open.get(token)
        if (known) return known
        const source = sources.get(token) ?? planError(`No source ${token}`)
        let reader: ZipReader
        try {
            reader = await ZipReader.open(source.file)
            if (reader.recovered) throw new ZipError('directory')
        } catch (error) {
            throw await sourceFailure({ token, source }, error)
        }
        const opened = { token, source, reader }
        open.set(token, opened)
        return opened
    }

    if (plan.entries.length >= ENTRY_LIMIT) planError('65,535 entries or more')
    const prepared: PreparedEntry[] = []
    for (const entry of plan.entries) prepared.push(await executeEntry(entry, sourceFor))

    // A source that changed while it was read is a conflict, whatever the copies found.
    for (const { token, source } of open.values()) {
        if ((await source.readFingerprint()) !== source.fingerprint)
            throw new ExecutionError('conflict', `${token} changed`, { token, role: source.role })
    }

    try {
        return new Blob(assembleZip(prepared, { modified: plan.modified }), {
            type: 'application/octet-stream',
        })
    } catch (error) {
        if (error instanceof ZipError) planError(error.message)
        throw error
    }
}

/** A failure reading a source: a conflict when its fingerprint changed, else damage in it. */
const sourceFailure = async (
    { token, source }: { token: string; source: ExecutionSource },
    error: unknown,
) => {
    if (error instanceof ExecutionError) return error
    let changed: boolean
    try {
        changed = (await source.readFingerprint()) !== source.fingerprint
    } catch {
        changed = true
    }
    const message = error instanceof Error ? error.message : String(error)
    return new ExecutionError(changed ? 'conflict' : 'io', `${token}: ${message}`, {
        token,
        role: source.role,
    })
}

const executeEntry = async (
    entry: PlannedEntry,
    sourceFor: (token: string) => Promise<OpenSource>,
): Promise<PreparedEntry> => {
    const { name, method } = entry
    // A plan can come from JSON (the conformance set), so its method is checked too.
    if (![0, 8].includes(method)) planError(`${name}: method ${String(method)}`)
    if (method === 8) {
        if (entry.crc32 === undefined || entry.uncompressedSize === undefined)
            planError(`${name}: a method-8 entry needs its CRC and size`)
        const [part] = entry.parts
        if (entry.parts.length !== 1 || !part || (part.kind === 'copy' && part.inflate))
            planError(`${name}: a method-8 entry is one bytes part or one whole-entry copy`)
    }

    const data: (Uint8Array<ArrayBuffer> | Blob)[] = []
    let crc = 0
    let size = 0
    let compressedSize = 0
    for (const part of entry.parts) {
        if (part.kind === 'bytes') {
            const bytes = new Uint8Array(part.data)
            if (method === 8) {
                // Inflated to compute what it holds; a stream past the planned size is a plan error.
                let inflated: Uint8Array
                try {
                    inflated = inflateExact(bytes, entry.uncompressedSize ?? 0)
                } catch {
                    return planError(`${name}: its bytes do not inflate to its planned size`)
                }
                crc = crc32(inflated)
                size = inflated.length
            } else {
                crc = crc32(bytes, crc)
                size += bytes.length
            }
            compressedSize += bytes.length
            data.push(bytes)
            continue
        }

        const opened = await sourceFor(part.source)
        const from =
            opened.reader.entries[part.entryIndex] ??
            planError(`${name}: no entry ${part.entryIndex} in ${part.source}`)
        let slice: Blob
        let uncompressed: Uint8Array
        try {
            // The local header gives where the data starts: it must be the plan's `dataOffset`.
            const fixed = await bytesOf(
                opened.source.file.slice(from.localOffset, from.localOffset + LOCAL_HEADER_SIZE),
            )
            if (from.localOffset + localHeaderSize(fixed) !== part.dataOffset)
                planError(
                    `${name}: entry ${part.entryIndex} of ${part.source} does not start at ${part.dataOffset}`,
                )
            if (!part.inflate && from.method !== method)
                planError(`${name}: method ${method}, but the source entry’s is ${from.method}`)
            if (from.method !== 0 && from.method !== 8) throw new ZipError('unsupported')
            // The whole entry, its CRC checked against the central directory (inflated when deflated).
            slice = await opened.reader.stored(from)
            const stored = await bytesOf(slice)
            uncompressed =
                from.method === 0
                    ? from.compressedSize === from.size
                        ? stored
                        : (() => {
                              throw new ZipError('size')
                          })()
                    : inflateExact(stored, from.size)
            if (crc32(uncompressed) !== from.crc32) throw new ZipError('crc', 'entry CRC')
        } catch (error) {
            throw await sourceFailure(opened, error)
        }

        // A copy writes the stored bytes as a slice of the source, or with `inflate` the inflated ones.
        crc = method === 8 ? from.crc32 : crc32(uncompressed, crc)
        size += uncompressed.length
        if (part.inflate) {
            compressedSize += uncompressed.length
            data.push(new Uint8Array(uncompressed))
        } else {
            compressedSize += from.compressedSize
            data.push(slice)
        }
    }

    if (entry.crc32 !== undefined && entry.crc32 !== crc) planError(`${name}: planned CRC differs`)
    if (entry.uncompressedSize !== undefined && entry.uncompressedSize !== size)
        planError(`${name}: planned size differs`)
    if (size >= ZIP32_LIMIT || compressedSize >= ZIP32_LIMIT) planError(`${name}: 4 GB or more`)
    return {
        name,
        method,
        crc32: crc,
        size,
        compressedSize,
        data: data.length === 1 && data[0] ? data[0] : new Blob(data),
    }
}

/** `buildNxsp`: a plan's bytes (the executor under the name the open and Save code use). */
export const buildNxsp = executePlan
