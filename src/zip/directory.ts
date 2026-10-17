import { ZipError } from './error'

// The pure parts of reading a ZIP: no I/O, so the lazy reader, the in-memory readers and `scp.ts` share them.

export const LOCAL_SIGNATURE = 0x04034b50
export const CENTRAL_SIGNATURE = 0x02014b50
export const END_SIGNATURE = 0x06054b50
const ZIP64_END_SIGNATURE = 0x06064b50
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50

export const LOCAL_HEADER_SIZE = 30
export const CENTRAL_HEADER_SIZE = 46
/** The most entries a reader accepts (§1.6.11.4): more is damage. */
export const ENTRY_CAP = 0xffff
export const ZIP64_END_SIZE = 56
/** How much of a file's end holds the end record, a comment and the ZIP64 locator. */
export const END_TAIL_SIZE = 0xffff + 22 + 20

export const SENTINEL_32 = 0xffffffff

export type ZipEntry = {
    index: number
    /** The name as stored, decoded by the UTF-8 flag, else UTF-8 when valid, else CP437. */
    name: string
    /** The name in NFC, for comparisons. */
    key: string
    rawName: Uint8Array
    flags: number
    method: number
    dosTime: number
    dosDate: number
    crc32: number
    compressedSize: number
    size: number
    localOffset: number
    isDirectory: boolean
    /** Set when a size or the offset came from the ZIP64 extra field. */
    zip64?: true
}

export type ZipEnd = {
    entryCount: number
    cdSize: number
    cdOffset: number
    /** Where the ZIP64 end record is, when the end record's fields are ZIP64 sentinels. */
    zip64Offset?: number
}

export const view = (bytes: Uint8Array) =>
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

const u64 = (v: DataView, offset: number) => {
    const value = v.getBigUint64(offset, true)
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError('directory', 'size')
    return Number(value)
}

/** Finds the end record in the last bytes of a file (at most `END_TAIL_SIZE`). */
export const findEnd = (tail: Uint8Array): ZipEnd => {
    const v = view(tail)
    let loose = -1
    for (let i = tail.length - 22; i >= 0; i--) {
        if (v.getUint32(i, true) !== END_SIGNATURE) continue

        // A signature inside the comment is skipped: the real record's comment runs to the end.
        const rest = tail.length - (i + 22)
        const commentLength = v.getUint16(i + 20, true)
        if (commentLength === rest) return readEnd(v, i)
        if (commentLength < rest && loose < 0) loose = i
    }
    if (loose < 0) throw new ZipError('directory', 'no end record')
    return readEnd(v, loose)
}

const readEnd = (v: DataView, at: number): ZipEnd => {
    const entryCount = v.getUint16(at + 10, true)
    const cdSize = v.getUint32(at + 12, true)
    const cdOffset = v.getUint32(at + 16, true)
    const end: ZipEnd = { entryCount, cdSize, cdOffset }
    if (entryCount !== 0xffff && cdSize !== SENTINEL_32 && cdOffset !== SENTINEL_32) return end

    if (at < 20 || v.getUint32(at - 20, true) !== ZIP64_LOCATOR_SIGNATURE) {
        throw new ZipError('directory', 'ZIP64 locator')
    }
    end.zip64Offset = u64(v, at - 20 + 8)
    return end
}

/** Reads the ZIP64 end record found at `end.zip64Offset`. */
export const parseZip64End = (bytes: Uint8Array): ZipEnd => {
    if (bytes.length < ZIP64_END_SIZE) throw new ZipError('directory', 'ZIP64 end')
    const v = view(bytes)
    if (v.getUint32(0, true) !== ZIP64_END_SIGNATURE) throw new ZipError('directory', 'ZIP64 end')
    return { entryCount: u64(v, 32), cdSize: u64(v, 40), cdOffset: u64(v, 48) }
}

// CP437 for the bytes 0x80 to 0xFF, what unzippers assume for a name that is neither flagged nor UTF-8.
const CP437 =
    'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ '

export const decodeName = (raw: Uint8Array, flags: number) => {
    if (flags & 0x0800) return new TextDecoder().decode(raw)
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(raw)
    } catch {
        let name = ''
        for (const byte of raw)
            name += byte < 0x80 ? String.fromCharCode(byte) : CP437.charAt(byte - 0x80)
        return name
    }
}

/** The whole size of a central-directory record, from its first 46 bytes. */
export const centralRecordSize = (fixed: Uint8Array) => {
    const v = view(fixed)
    if (fixed.length < CENTRAL_HEADER_SIZE || v.getUint32(0, true) !== CENTRAL_SIGNATURE) {
        throw new ZipError('directory', 'central directory')
    }
    return (
        CENTRAL_HEADER_SIZE + v.getUint16(28, true) + v.getUint16(30, true) + v.getUint16(32, true)
    )
}

/** Parses one central-directory record from `centralRecordSize` bytes. */
export const parseCentralRecord = (bytes: Uint8Array, index: number): ZipEntry => {
    const total = centralRecordSize(bytes)
    if (bytes.length < total) throw new ZipError('directory', 'central directory')
    const v = view(bytes)
    const flags = v.getUint16(8, true)
    const nameLength = v.getUint16(28, true)
    const extraLength = v.getUint16(30, true)
    const nameAt = CENTRAL_HEADER_SIZE
    const extraAt = nameAt + nameLength

    let size = v.getUint32(24, true)
    let compressedSize = v.getUint32(20, true)
    let localOffset = v.getUint32(42, true)
    const zip64 =
        size === SENTINEL_32 || compressedSize === SENTINEL_32 || localOffset === SENTINEL_32
    if (zip64) {
        const field = findExtra(bytes.subarray(extraAt, extraAt + extraLength), 1)
        if (!field) throw new ZipError('directory', 'ZIP64 extra')
        const f = view(field)
        let p = 0
        const take = () => {
            if (p + 8 > field.length) throw new ZipError('directory', 'ZIP64 extra')
            const value = u64(f, p)
            p += 8
            return value
        }
        if (size === SENTINEL_32) size = take()
        if (compressedSize === SENTINEL_32) compressedSize = take()
        if (localOffset === SENTINEL_32) localOffset = take()
    }

    const rawName = bytes.slice(nameAt, extraAt)
    const name = decodeName(rawName, flags)
    return {
        index,
        name,
        key: name.normalize('NFC'),
        rawName,
        flags,
        method: v.getUint16(10, true),
        dosTime: v.getUint16(12, true),
        dosDate: v.getUint16(14, true),
        crc32: v.getUint32(16, true),
        compressedSize,
        size,
        localOffset,
        isDirectory: name.endsWith('/'),
        ...(zip64 ? { zip64: true as const } : {}),
    }
}

/** Parses a central directory (`bytes` starts at its first record) of `entryCount` entries. */
export const parseCentralDirectory = (bytes: Uint8Array, entryCount: number): ZipEntry[] => {
    if (entryCount > ENTRY_CAP) throw new ZipError('limit', 'entries')
    const entries: ZipEntry[] = []
    let at = 0
    for (let index = 0; index < entryCount; index++) {
        const next = at + centralRecordSize(bytes.subarray(at))
        if (next > bytes.length) throw new ZipError('directory', 'central directory')
        entries.push(parseCentralRecord(bytes.subarray(at, next), index))
        at = next
    }
    return entries
}

const findExtra = (extra: Uint8Array, id: number) => {
    const v = view(extra)
    let p = 0
    while (p + 4 <= extra.length) {
        const length = v.getUint16(p + 2, true)
        if (p + 4 + length > extra.length) return
        if (v.getUint16(p, true) === id) return extra.subarray(p + 4, p + 4 + length)
        p += 4 + length
    }
    return
}

export type LocalHeader = {
    flags: number
    method: number
    dosTime: number
    dosDate: number
    crc32: number
    compressedSize: number
    size: number
    rawName: Uint8Array
    /** Where the data starts, from the header's own start. */
    dataStart: number
}

/** The whole size of a local header, from its first 30 bytes. */
export const localHeaderSize = (fixed: Uint8Array) => {
    if (fixed.length < LOCAL_HEADER_SIZE) throw new ZipError('truncated', 'local header')
    const v = view(fixed)
    if (v.getUint32(0, true) !== LOCAL_SIGNATURE) throw new ZipError('header', 'local header')
    return LOCAL_HEADER_SIZE + v.getUint16(26, true) + v.getUint16(28, true)
}

/** Parses a local header from `localHeaderSize` bytes. */
export const parseLocalHeader = (bytes: Uint8Array): LocalHeader => {
    const total = localHeaderSize(bytes)
    if (bytes.length < total) throw new ZipError('truncated', 'local header')
    const v = view(bytes)
    const nameLength = v.getUint16(26, true)
    const extra = bytes.subarray(LOCAL_HEADER_SIZE + nameLength, total)
    let compressedSize = v.getUint32(18, true)
    let size = v.getUint32(22, true)
    if (compressedSize === SENTINEL_32 || size === SENTINEL_32) {
        const field = findExtra(extra, 1)
        if (field && field.length >= 16) {
            const f = view(field)
            if (size === SENTINEL_32) size = u64(f, 0)
            if (compressedSize === SENTINEL_32) compressedSize = u64(f, 8)
        }
    }
    return {
        flags: v.getUint16(6, true),
        method: v.getUint16(8, true),
        dosTime: v.getUint16(10, true),
        dosDate: v.getUint16(12, true),
        crc32: v.getUint32(14, true),
        compressedSize,
        size,
        rawName: bytes.slice(LOCAL_HEADER_SIZE, LOCAL_HEADER_SIZE + nameLength),
        dataStart: total,
    }
}

/** Reads the central directory of a whole file held in memory (ZIP64 included). */
export const readDirectory = (bytes: Uint8Array): ZipEntry[] => {
    let end = findEnd(bytes.subarray(Math.max(0, bytes.length - END_TAIL_SIZE)))
    if (end.zip64Offset !== undefined) {
        end = parseZip64End(bytes.subarray(end.zip64Offset, end.zip64Offset + ZIP64_END_SIZE))
    }
    if (end.cdOffset > bytes.length) throw new ZipError('directory', 'central directory')
    return parseCentralDirectory(bytes.subarray(end.cdOffset), end.entryCount)
}

/** Where an entry's stored data starts in a whole file held in memory. */
export const dataStart = (bytes: Uint8Array, entry: ZipEntry) => {
    const header = bytes.subarray(entry.localOffset, entry.localOffset + LOCAL_HEADER_SIZE)
    return entry.localOffset + localHeaderSize(header)
}

export type Ambiguity = { duplicates: string[]; overlapping: string[] }

/** Entries sharing a name (NFC) and entries whose data ranges overlap: both make a file ambiguous. */
export const findAmbiguities = (entries: readonly ZipEntry[]): Ambiguity => {
    const seen = new Set<string>()
    const duplicates = new Set<string>()
    for (const entry of entries) {
        if (seen.has(entry.key)) duplicates.add(entry.key)
        seen.add(entry.key)
    }

    // The least a range can cover is the fixed header, the name and the stored data; the reader
    // checks the real range, with the local extra field, when it reads an entry.
    const ranges = entries
        .filter((entry) => !entry.isDirectory)
        .map((entry) => ({
            entry,
            start: entry.localOffset,
            end:
                entry.localOffset + LOCAL_HEADER_SIZE + entry.rawName.length + entry.compressedSize,
        }))
        .sort((a, b) => a.start - b.start)
    const overlapping = new Set<string>()
    let previous: (typeof ranges)[number] | undefined
    for (const current of ranges) {
        if (previous && current.start < previous.end) {
            overlapping.add(previous.entry.key)
            overlapping.add(current.entry.key)
        }
        // Keep the furthest reach, so one long range is compared against every later start.
        if (!previous || current.end > previous.end) previous = current
    }
    return { duplicates: [...duplicates], overlapping: [...overlapping] }
}

/** Entries that readers skip (§1.6.11.4): directories, `__MACOSX/`, `cache/` and OS clutter. */
export const isIgnoredEntry = (entry: Pick<ZipEntry, 'key' | 'isDirectory'>) => {
    if (entry.isDirectory) return true
    const { key } = entry
    if (key.startsWith('__MACOSX/') || key.startsWith('cache/')) return true
    const last = key.slice(key.lastIndexOf('/') + 1)
    return (
        last === '.DS_Store' ||
        last === 'Thumbs.db' ||
        last === 'desktop.ini' ||
        last.startsWith('._')
    )
}
