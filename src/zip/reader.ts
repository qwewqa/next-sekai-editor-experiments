import { crc32 } from './crc32'
import {
    CENTRAL_HEADER_SIZE,
    END_TAIL_SIZE,
    ENTRY_CAP,
    LOCAL_HEADER_SIZE,
    LOCAL_SIGNATURE,
    SENTINEL_32,
    ZIP64_END_SIZE,
    centralRecordSize,
    decodeName,
    findAmbiguities,
    findEnd,
    localHeaderSize,
    parseCentralRecord,
    parseLocalHeader,
    parseZip64End,
    view,
    type LocalHeader,
    type ZipEntry,
} from './directory'
import { ZipError } from './error'
import { inflateExact } from './inflate'

export type ReadOptions = {
    /** A cap on the entry's inflated size; an entry that declares more is refused before it is read. */
    maxSize: number
}

/** How much a scan or a central-directory read takes from the file at once. */
const WINDOW_SIZE = 1024 * 1024

/** The most a local header's name and extra field can add to an entry's least range. */
const MAX_HEADER_SLACK = 2 * 0xffff

/**
 * A ZIP read lazily from a Blob or File: the central directory first, and when
 * it is missing or damaged, a sequential scan of local headers (`recovered`).
 * Every read verifies the entry's CRC. Names that are ambiguous (duplicates, or
 * data ranges that overlap) are listed in `ambiguous` and `get` does not find them.
 */
export class ZipReader {
    private readonly byKey = new Map<string, ZipEntry>()
    /** Files by local offset, with the furthest least reach so far, for the overlap check on read. */
    private readonly byOffset: { entry: ZipEntry; reach: number }[]
    private readonly headerSizes = new Map<ZipEntry, number>()

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

        let reach = 0
        this.byOffset = entries
            .filter((entry) => !entry.isDirectory)
            .sort((a, b) => a.localOffset - b.localOffset)
            .map((entry) => {
                reach = Math.max(reach, leastEnd(entry))
                return { entry, reach }
            })
    }

    readonly ambiguous: ReadonlySet<string>
    readonly duplicates: readonly string[]
    readonly overlapping: readonly string[]

    static async open(source: Blob) {
        try {
            return new ZipReader(source, await readFromDirectory(source), false)
        } catch (error) {
            // Past the entry cap is damage the scan must not get around.
            if (error instanceof ZipError && error.code === 'limit') throw error
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
        // With a data descriptor, the local header's CRC and sizes may be left zero; filled-in ones must agree.
        const differs = (local: number, central: number) =>
            local !== central && (!(header.flags & 8) || (local !== 0 && local !== SENTINEL_32))
        if (
            differs(header.crc32, entry.crc32) ||
            differs(header.compressedSize, entry.compressedSize) ||
            differs(header.size, entry.size)
        ) {
            throw new ZipError('header', `${entry.name}: local header`)
        }
        this.headerSizes.set(entry, total)

        const start = entry.localOffset + total
        const end = start + entry.compressedSize
        if (end > source.size) throw new ZipError('truncated', entry.name)
        if (!entry.isDirectory) await this.checkOverlap(entry, end)
        return source.slice(start, end)
    }

    /**
     * Refuses an entry whose real range (with its local extra field) holds another
     * entry's start, or starts inside an earlier entry's real range (§1.6.11.4).
     */
    private async checkOverlap(entry: ZipEntry, end: number) {
        const { byOffset } = this
        let after = 0
        let before = byOffset.length
        while (after < before) {
            const mid = (after + before) >> 1
            if ((byOffset[mid]?.entry.localOffset ?? Infinity) <= entry.localOffset) after = mid + 1
            else before = mid
        }
        const overlap = () => new ZipError('ambiguous', `${entry.name}: overlapping data`)
        if ((byOffset[after]?.entry.localOffset ?? Infinity) < end) throw overlap()

        // An earlier entry reaches at most `MAX_HEADER_SLACK` past its least end, so the walk stops there.
        const walked: ZipEntry[] = []
        for (let i = after - 1; i >= 0; i--) {
            const { entry: other, reach } = byOffset[i] ?? { entry, reach: 0 }
            if (reach + MAX_HEADER_SLACK <= entry.localOffset) break
            if (other !== entry) walked.push(other)
        }
        await this.readHeaderSizes(walked.filter((other) => !this.headerSizes.has(other)))
        for (const other of walked) {
            const total = this.headerSizes.get(other) ?? 0
            if (other.localOffset + total + other.compressedSize > entry.localOffset)
                throw overlap()
        }
    }

    /**
     * The entries whose real ranges (from their local headers, with the extra fields) overlap,
     * every entry included, ignored ones too (§1.6.11.4), so every reader calls the same file
     * damaged. The headers are read in offset order through one window.
     */
    async realOverlaps() {
        const window = new Window(this.source)
        const found = new Set<string>()
        let furthest: { entry: ZipEntry; end: number } | undefined
        for (const { entry } of this.byOffset) {
            if (furthest && entry.localOffset < furthest.end) {
                found.add(furthest.entry.key)
                found.add(entry.key)
            }
            let total = this.headerSizes.get(entry)
            if (total === undefined) {
                try {
                    const at = entry.localOffset
                    total = localHeaderSize(await window.get(at, at + LOCAL_HEADER_SIZE))
                } catch (error) {
                    // A header that cannot be read is that entry's damage, found when it is read.
                    if (!(error instanceof ZipError)) throw error
                    total = LOCAL_HEADER_SIZE + entry.rawName.length
                }
                this.headerSizes.set(entry, total)
            }
            const end = entry.localOffset + total + entry.compressedSize
            if (!furthest || end > furthest.end) furthest = { entry, end }
        }
        return [...found]
    }

    /**
     * Reads the whole size of each entry's local header, once. Headers close together come from
     * one slice; scattered ones are read together.
     */
    private async readHeaderSizes(entries: ZipEntry[]) {
        // Walked from the highest offset down, so the lowest is last.
        const lowest = entries.at(-1)?.localOffset ?? 0
        const highest = entries[0]?.localOffset ?? 0
        const span = highest + LOCAL_HEADER_SIZE - lowest
        const near =
            entries.length > 1 && span <= WINDOW_SIZE
                ? bytesOf(this.source, lowest, lowest + span)
                : undefined
        const fixedOf = async (entry: ZipEntry) =>
            near
                ? (await near).subarray(
                      entry.localOffset - lowest,
                      entry.localOffset - lowest + LOCAL_HEADER_SIZE,
                  )
                : bytesOf(this.source, entry.localOffset, entry.localOffset + LOCAL_HEADER_SIZE)
        const fixeds = await Promise.all(entries.map(fixedOf))
        entries.forEach((entry, i) => {
            let total = 0
            try {
                total = localHeaderSize(fixeds[i] ?? new Uint8Array(0))
            } catch (error) {
                // A header that cannot be read is that entry's damage, found when it is read.
                if (!(error instanceof ZipError)) throw error
            }
            this.headerSizes.set(entry, total)
        })
    }

    /** The entry's uncompressed bytes, with its CRC and declared size verified. */
    async read(entry: ZipEntry, { maxSize }: ReadOptions) {
        if (entry.flags & 1) throw new ZipError('unsupported', `${entry.name}: encrypted`)
        if (entry.method !== 0 && entry.method !== 8) {
            throw new ZipError('unsupported', `${entry.name}: method ${entry.method}`)
        }
        if (entry.size > maxSize) throw new ZipError('too-large', entry.name)
        // The stored size is checked before it is read, so a small entry cannot make a large read.
        if (
            entry.method === 0
                ? entry.compressedSize !== entry.size
                : entry.compressedSize > deflateBound(entry.size)
        ) {
            throw new ZipError('size', entry.name)
        }

        const stored = new Uint8Array(await (await this.stored(entry)).arrayBuffer())
        const data = entry.method === 0 ? stored : inflateExact(stored, entry.size)
        if (crc32(data) !== entry.crc32) throw new ZipError('crc', entry.name)
        return data
    }
}

/** A generous bound on the DEFLATE stream of `size` bytes: past it, the stored size is damage. */
const deflateBound = (size: number) => size * 2 + 1024

/** Where an entry's range ends at least: the fixed header, the name and the stored data. */
const leastEnd = (entry: ZipEntry) =>
    entry.localOffset + LOCAL_HEADER_SIZE + entry.rawName.length + entry.compressedSize

const bytesOf = async (source: Blob, start: number, end: number) =>
    new Uint8Array(await source.slice(start, end).arrayBuffer())

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((byte, i) => byte === b[i])

/** Reads a Blob up to `limit` through a window, so many small reads take few slices. */
class Window {
    private start = 0
    private bytes = new Uint8Array(0)

    constructor(
        private readonly source: Blob,
        private readonly limit = source.size,
    ) {}

    /** The bytes from `start` to `end`, fewer when `end` is past the limit. */
    async get(start: number, end: number) {
        if (start < this.start || end > this.start + this.bytes.length) {
            const to = Math.min(this.limit, Math.max(end, start + WINDOW_SIZE))
            this.bytes = await bytesOf(this.source, start, Math.max(start, to))
            this.start = start
        }
        return this.bytes.subarray(start - this.start, end - this.start)
    }
}

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
    if (end.entryCount > ENTRY_CAP) throw new ZipError('limit', 'entries')
    const cdEnd = end.cdOffset + end.cdSize
    if (cdEnd > size || end.entryCount * CENTRAL_HEADER_SIZE > end.cdSize) {
        throw new ZipError('directory', 'central directory')
    }

    // Read record by record through a window, so a directory that claims the whole file is not read at once.
    const window = new Window(source, cdEnd)
    const entries: ZipEntry[] = []
    let at = end.cdOffset
    for (let index = 0; index < end.entryCount; index++) {
        const next = at + centralRecordSize(await window.get(at, at + CENTRAL_HEADER_SIZE))
        if (next > cdEnd) throw new ZipError('directory', 'central directory')
        const entry = parseCentralRecord(await window.get(at, next), index)
        // An entry that reaches past the file means the file was cut, so the directory cannot be trusted.
        if (leastEnd(entry) > size) throw new ZipError('truncated', entry.name)
        entries.push(entry)
        at = next
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

const DESCRIPTOR_SIGNATURE = 0x08074b50

/** The length of the data descriptor at `at` that matches `header`, or 0 when there is none. */
const descriptorLength = async (window: Window, at: number, header: LocalHeader) => {
    const bytes = await window.get(at, at + 24)
    const v = view(bytes)
    const signed = bytes.length >= 4 && v.getUint32(0, true) === DESCRIPTOR_SIGNATURE ? 4 : 0
    for (const wide of [false, true]) {
        const length = signed + (wide ? 20 : 12)
        if (bytes.length < length || v.getUint32(signed, true) !== header.crc32) continue
        const [compressedSize, size] = wide
            ? [Number(v.getBigUint64(signed + 4, true)), Number(v.getBigUint64(signed + 12, true))]
            : [v.getUint32(signed + 4, true), v.getUint32(signed + 8, true)]
        if (compressedSize === header.compressedSize && size === header.size) return length
    }
    return 0
}

/** Walks local headers from the start, keeping every entry whose data is wholly there. */
const scanLocalHeaders = async (source: Blob) => {
    const { size } = source
    const window = new Window(source)
    const entries: ZipEntry[] = []
    let at = 0
    while (at + LOCAL_HEADER_SIZE <= size) {
        const fixed = await window.get(at, at + LOCAL_HEADER_SIZE)
        if (view(fixed).getUint32(0, true) !== LOCAL_SIGNATURE) break
        const total = localHeaderSize(fixed)
        if (at + total > size) break

        const header = parseLocalHeader(await window.get(at, at + total))
        // With a data descriptor and no sizes here, the data's end is unknown, so the scan stops.
        if (header.flags & 8 && header.compressedSize === 0) break
        let next = at + total + header.compressedSize
        if (next > size) break

        if (entries.length === ENTRY_CAP) throw new ZipError('limit', 'entries')
        entries.push(entryFromLocal(header, at, entries.length))
        if (header.flags & 8) next += await descriptorLength(window, next, header)
        at = next
    }
    if (entries.length === 0) {
        const head = await bytesOf(source, 0, Math.min(4, size))
        throw new ZipError(
            head.length === 4 && view(head).getUint32(0, true) === LOCAL_SIGNATURE
                ? 'truncated'
                : 'not-zip',
        )
    }
    return entries
}
