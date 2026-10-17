import { crc32 } from './crc32'
import {
    END_TAIL_SIZE,
    LOCAL_HEADER_SIZE,
    LOCAL_SIGNATURE,
    ZIP64_END_SIZE,
    decodeName,
    findAmbiguities,
    findEnd,
    localHeaderSize,
    parseCentralDirectory,
    parseLocalHeader,
    parseZip64End,
    type LocalHeader,
    type ZipEntry,
} from './directory'
import { ZipError } from './error'
import { inflateExact } from './inflate'

export type ReadOptions = {
    /** A cap on the entry's inflated size; an entry that declares more is refused before it is read. */
    maxSize?: number
}

/**
 * A ZIP read lazily from a Blob or File: the central directory first, and when
 * it is missing or damaged, a sequential scan of local headers (`recovered`).
 * Every read verifies the entry's CRC. Names that are ambiguous (duplicates, or
 * data ranges that overlap) are listed in `ambiguous` and `get` does not find them.
 */
export class ZipReader {
    private readonly byKey = new Map<string, ZipEntry>()

    private constructor(
        readonly source: Blob,
        readonly entries: readonly ZipEntry[],
        /** Whether the entries came from a scan because the central directory could not be read. */
        readonly recovered: boolean,
    ) {
        const { duplicates, overlapping } = findAmbiguities(entries)
        this.ambiguous = new Set([...duplicates, ...overlapping])
        this.duplicates = duplicates
        this.overlapping = overlapping
        for (const entry of entries) {
            if (!this.ambiguous.has(entry.key)) this.byKey.set(entry.key, entry)
        }
    }

    readonly ambiguous: ReadonlySet<string>
    readonly duplicates: readonly string[]
    readonly overlapping: readonly string[]

    static async open(source: Blob) {
        try {
            return new ZipReader(source, await readFromDirectory(source), false)
        } catch (error) {
            if (!(error instanceof ZipError || error instanceof RangeError)) throw error
        }
        return new ZipReader(source, await scanLocalHeaders(source), true)
    }

    /** The entry named `name` (compared in NFC), unless the name is ambiguous. */
    get(name: string) {
        return this.byKey.get(name.normalize('NFC'))
    }

    /** The entry's stored bytes (compressed, for DEFLATE) as a lazy slice, after the local header agrees. */
    async stored(entry: ZipEntry) {
        const { source } = this
        if (entry.localOffset + LOCAL_HEADER_SIZE > source.size) throw new ZipError('truncated')

        const fixed = await bytesOf(
            source,
            entry.localOffset,
            entry.localOffset + LOCAL_HEADER_SIZE,
        )
        const total = localHeaderSize(fixed)
        const header = parseLocalHeader(
            await bytesOf(source, entry.localOffset, entry.localOffset + total),
        )
        if (!sameBytes(header.rawName, entry.rawName) || header.method !== entry.method) {
            throw new ZipError('header', `${entry.name}: local header`)
        }
        // With a data descriptor, the local header's CRC and sizes are not filled in.
        if (
            !(header.flags & 8) &&
            (header.crc32 !== entry.crc32 ||
                header.compressedSize !== entry.compressedSize ||
                header.size !== entry.size)
        ) {
            throw new ZipError('header', `${entry.name}: local header`)
        }

        const start = entry.localOffset + total
        const end = start + entry.compressedSize
        if (end > source.size) throw new ZipError('truncated', entry.name)
        return source.slice(start, end)
    }

    /** The entry's uncompressed bytes, with its CRC and declared size verified. */
    async read(entry: ZipEntry, options: ReadOptions = {}) {
        if (entry.flags & 1) throw new ZipError('unsupported', `${entry.name}: encrypted`)
        if (entry.method !== 0 && entry.method !== 8) {
            throw new ZipError('unsupported', `${entry.name}: method ${entry.method}`)
        }
        if (options.maxSize !== undefined && entry.size > options.maxSize) {
            throw new ZipError('too-large', entry.name)
        }

        const stored = new Uint8Array(await (await this.stored(entry)).arrayBuffer())
        let data: Uint8Array
        if (entry.method === 0) {
            if (stored.length !== entry.size) throw new ZipError('size', entry.name)
            data = stored
        } else {
            data = inflateExact(stored, entry.size)
        }
        if (crc32(data) !== entry.crc32) throw new ZipError('crc', entry.name)
        return data
    }
}

const bytesOf = async (source: Blob, start: number, end: number) =>
    new Uint8Array(await source.slice(start, end).arrayBuffer())

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((byte, i) => byte === b[i])

const readFromDirectory = async (source: Blob) => {
    const { size } = source
    let end = findEnd(await bytesOf(source, Math.max(0, size - END_TAIL_SIZE), size))
    if (end.zip64Offset !== undefined) {
        end = parseZip64End(
            await bytesOf(
                source,
                end.zip64Offset,
                Math.min(size, end.zip64Offset + ZIP64_END_SIZE),
            ),
        )
    }
    if (end.cdOffset + end.cdSize > size) throw new ZipError('directory', 'central directory')

    const entries = parseCentralDirectory(
        await bytesOf(source, end.cdOffset, end.cdOffset + end.cdSize),
        end.entryCount,
    )
    // An entry that reaches past the file means the file was cut, so the directory cannot be trusted.
    for (const entry of entries) {
        const reach =
            entry.localOffset + LOCAL_HEADER_SIZE + entry.rawName.length + entry.compressedSize
        if (reach > size) throw new ZipError('truncated', entry.name)
    }
    return entries
}

const entryFromLocal = (header: LocalHeader, offset: number, index: number): ZipEntry => {
    const { rawName, flags } = header
    const name = decodeName(rawName, flags)
    return {
        index,
        name,
        key: name.normalize('NFC'),
        rawName,
        flags,
        method: header.method,
        dosTime: header.dosTime,
        dosDate: header.dosDate,
        crc32: header.crc32,
        compressedSize: header.compressedSize,
        size: header.size,
        localOffset: offset,
        isDirectory: name.endsWith('/'),
    }
}

/** Walks local headers from the start, keeping every entry whose data is wholly there. */
const scanLocalHeaders = async (source: Blob) => {
    const { size } = source
    const entries: ZipEntry[] = []
    let at = 0
    while (at + LOCAL_HEADER_SIZE <= size) {
        const fixed = await bytesOf(source, at, at + LOCAL_HEADER_SIZE)
        if (new DataView(fixed.buffer).getUint32(0, true) !== LOCAL_SIGNATURE) break
        const total = localHeaderSize(fixed)
        if (at + total > size) break

        const header = parseLocalHeader(await bytesOf(source, at, at + total))
        // A deflated entry with a data descriptor has no size here, so the scan cannot go past it.
        if (header.flags & 8 && header.compressedSize === 0 && header.method !== 0) break
        const next = at + total + header.compressedSize
        if (next > size) break

        entries.push(entryFromLocal(header, at, entries.length))
        at = next
    }
    if (entries.length === 0) {
        const head = await bytesOf(source, 0, Math.min(4, size))
        throw new ZipError(
            head.length === 4 && new DataView(head.buffer).getUint32(0, true) === LOCAL_SIGNATURE
                ? 'truncated'
                : 'not-zip',
        )
    }
    return entries
}
