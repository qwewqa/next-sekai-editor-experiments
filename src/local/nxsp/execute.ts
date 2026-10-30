import { deflateRaw } from 'pako'
import { crc32 } from '../../zip/crc32'
import { LOCAL_HEADER_SIZE, localHeaderSize } from '../../zip/directory'
import { ZipError } from '../../zip/error'
import { inflatedCrc, inflateExact } from '../../zip/inflate'
import { ZipReader } from '../../zip/reader'
import { assembleZip, type PreparedEntry } from '../../zip/writer'
import { ENTRY_LIMIT, ZIP32_LIMIT, type PlannedEntry, type WritePlan } from './plan'
import { scpEntries, scpHash } from './scp'

// The executor: it follows a plan exactly. Every copy reads through the pinned source
// its token names, by central-directory index and `dataOffset`, and is checked by the entry's CRC;
// the CRC and sizes of what it writes are computed, never trusted; a plan that breaks the contract
// is a plan error, a copy that fails is damage in its source, or a conflict when the source changed.
// Every check that depends on a source's bytes reads its fingerprint first: a source
// whose bytes changed after `inspect` is a conflict, whatever check it failed.

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
    const hashes = new Map<string, string>()
    for (const entry of plan.entries) {
        const [part] = entry.parts
        if (part?.kind !== 'scp') {
            prepared.push(await executeEntry(entry, sourceFor))
            continue
        }
        if (entry.parts.length !== 1 || entry.method !== 8 || entry.crc32 !== undefined)
            planError(`${entry.name}: invalid package projection`)
        const resources = new Set<string>()
        scpEntries(part.project, (name) => {
            resources.add(name)
            return ''
        })
        for (const name of resources) {
            if (hashes.has(name)) continue
            const resource = prepared.find((item) => item.name === name)
            if (resource?.method !== 0)
                return planError(`${entry.name}: no prepared STORE resource ${name}`)
            let bytes: Uint8Array
            try {
                const data = resource.data
                bytes = data instanceof Blob ? await bytesOf(data) : data
            } catch (error) {
                const copied = plan.entries
                    .find((item) => item.name === name)
                    ?.parts.filter((item) => item.kind === 'copy')
                for (const copy of copied ?? []) {
                    const source = await sourceFor(copy.source)
                    throw await sourceFailure(source, error)
                }
                throw error
            }
            hashes.set(name, await scpHash(bytes))
        }
        const value = scpEntries(part.project, (name) => hashes.get(name) ?? planError(name)).get(
            entry.name,
        )
        if (value === undefined) planError(`${entry.name}: unknown package projection`)
        const bytes = new TextEncoder().encode(JSON.stringify(value))
        prepared.push(
            await executeEntry(
                {
                    ...entry,
                    crc32: crc32(bytes),
                    parts: [{ kind: 'bytes', data: deflateRaw(bytes) }],
                },
                sourceFor,
            ),
        )
    }

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

/** Whether a source's fingerprint now differs from the pinned one (unreadable counts as changed). */
const hasChanged = async (source: ExecutionSource) => {
    try {
        return (await source.readFingerprint()) !== source.fingerprint
    } catch {
        return true
    }
}

const conflict = ({ token, source }: { token: string; source: ExecutionSource }, message: string) =>
    new ExecutionError('conflict', `${token} changed: ${message}`, { token, role: source.role })

/** A failure reading a source: a conflict when its fingerprint changed, else damage in it. */
const sourceFailure = async (
    opened: { token: string; source: ExecutionSource },
    error: unknown,
) => {
    if (error instanceof ExecutionError) return error
    const message = error instanceof Error ? error.message : String(error)
    if (await hasChanged(opened.source)) return conflict(opened, message)
    return new ExecutionError('io', `${opened.token}: ${message}`, {
        token: opened.token,
        role: opened.source.role,
    })
}

/** A plan error found from a source's bytes: a conflict instead when any of those sources changed. */
const sourcePlanError = async (
    sources: readonly { token: string; source: ExecutionSource }[],
    message: string,
): Promise<never> => {
    for (const opened of sources) {
        if (await hasChanged(opened.source)) throw conflict(opened, message)
    }
    throw new ExecutionError('plan', message)
}

/** How much of a stored copy is read at once to compute its CRC. */
const CRC_SLICE = 8 * 1024 * 1024

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
    const copied: OpenSource[] = []
    let crc = 0
    let size = 0
    let compressedSize = 0
    for (const part of entry.parts) {
        if (part.kind === 'scp') return planError(`${name}: misplaced package projection`)
        if (part.kind === 'bytes') {
            const bytes = new Uint8Array(part.data)
            if (method === 8) {
                // Inflated to compute what it holds; a stream past the planned size is a plan error.
                try {
                    crc = inflatedCrc(bytes, entry.uncompressedSize ?? 0)
                } catch {
                    return planError(`${name}: its bytes do not inflate to its planned size`)
                }
                size = entry.uncompressedSize ?? 0
            } else {
                crc = crc32(bytes, crc)
                size += bytes.length
            }
            compressedSize += bytes.length
            data.push(bytes)
            continue
        }

        const opened = await sourceFor(part.source)
        copied.push(opened)
        const from =
            opened.reader.entries[part.entryIndex] ??
            (await sourcePlanError(
                [opened],
                `${name}: no entry ${part.entryIndex} in ${part.source}`,
            ))
        try {
            // The local header gives where the data starts: it must be the plan's `dataOffset`.
            const fixed = await bytesOf(
                opened.source.file.slice(from.localOffset, from.localOffset + LOCAL_HEADER_SIZE),
            )
            if (from.localOffset + localHeaderSize(fixed) !== part.dataOffset)
                await sourcePlanError(
                    [opened],
                    `${name}: entry ${part.entryIndex} of ${part.source} does not start at ${part.dataOffset}`,
                )
            if (!part.inflate && from.method !== method)
                await sourcePlanError(
                    [opened],
                    `${name}: method ${method}, but the source entry’s is ${from.method}`,
                )
            if (part.inflate && from.method !== 8)
                await sourcePlanError([opened], `${name}: an inflate copy of a STORE entry`)
            if (from.method !== 0 && from.method !== 8) throw new ZipError('unsupported')
            // An entry past the planned size is never inflated or read.
            if (entry.uncompressedSize !== undefined && size + from.size > entry.uncompressedSize)
                await sourcePlanError([opened], `${name}: planned size differs`)
        } catch (error) {
            throw await sourceFailure(opened, error)
        }

        // The whole entry, its CRC checked against the central directory (inflated when deflated).
        // A STORE copy is read by slices and written as a slice of the source; an `inflate` copy
        // writes the inflated bytes; a DEFLATE copy is inflated only to compute its CRC.
        try {
            const slice = await opened.reader.stored(from)
            if (from.method === 0) {
                if (from.compressedSize !== from.size) throw new ZipError('size')
                let own = 0
                for (let at = 0; at < slice.size; at += CRC_SLICE) {
                    const bytes = await bytesOf(slice.slice(at, at + CRC_SLICE))
                    own = crc32(bytes, own)
                    if (size) crc = crc32(bytes, crc)
                }
                if (own !== from.crc32) throw new ZipError('crc', 'entry CRC')
                if (!size) crc = own
                compressedSize += from.compressedSize
                data.push(slice)
            } else if (part.inflate) {
                const inflated = inflateExact(await bytesOf(slice), from.size)
                if (crc32(inflated) !== from.crc32) throw new ZipError('crc', 'entry CRC')
                crc = crc32(inflated, crc)
                compressedSize += inflated.length
                data.push(inflated)
            } else {
                if (inflatedCrc(await bytesOf(slice), from.size) !== from.crc32)
                    throw new ZipError('crc', 'entry CRC')
                // A method-8 entry is this one copy, so its CRC is the source entry's.
                crc = from.crc32
                compressedSize += from.compressedSize
                data.push(slice)
            }
            size += from.size
        } catch (error) {
            throw await sourceFailure(opened, error)
        }
    }

    // What the plan expected, against what the copies hold now: a source that changed is a conflict.
    if (entry.crc32 !== undefined && entry.crc32 !== crc)
        await sourcePlanError(copied, `${name}: planned CRC differs`)
    if (entry.uncompressedSize !== undefined && entry.uncompressedSize !== size)
        await sourcePlanError(copied, `${name}: planned size differs`)
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
