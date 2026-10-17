import { deflateRaw } from 'pako'
import { crc32 } from './crc32'
import { ZipError } from './error'

export type DosTime = { dosTime: number; dosDate: number }

/** 1980-01-01 00:00:00, the earliest DOS time. */
export const DOS_EPOCH: DosTime = { dosTime: 0, dosDate: (1 << 5) | 1 }

/** The DOS time and date of an instant in UTC, clamped to 1980-01-01 00:00:00 … 2107-12-31 23:59:58 (§1.6.11.7). */
export const dosFromDate = (date: Date): DosTime => {
    const min = Date.UTC(1980, 0, 1)
    const max = Date.UTC(2107, 11, 31, 23, 59, 58)
    const d = new Date(Math.min(max, Math.max(min, date.getTime())))
    return {
        dosTime: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
        dosDate: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
    }
}

export type ZipInput = {
    name: string
    /** `store` for data that is already compressed, `deflate` for the rest. */
    method: 'store' | 'deflate'
    data: Uint8Array<ArrayBuffer> | Blob
}

/** An entry with its CRC and sizes known. `assembleZip` trusts these to describe `data`. */
export type PreparedEntry = {
    name: string
    method: 0 | 8
    crc32: number
    size: number
    compressedSize: number
    data: Uint8Array<ArrayBuffer> | Blob
}

export type ZipOptions = {
    /** Written verbatim to every header; the writer never reads a clock. */
    modified?: DosTime
}

// A CRC is computed in slices, so a large Blob is never held whole just for it.
const CRC_SLICE = 8 * 1024 * 1024

export const prepareEntry = async (input: ZipInput): Promise<PreparedEntry> => {
    const { name, data } = input
    if (input.method === 'store') {
        let crc = 0
        if (data instanceof Blob) {
            for (let at = 0; at < data.size; at += CRC_SLICE) {
                crc = crc32(new Uint8Array(await data.slice(at, at + CRC_SLICE).arrayBuffer()), crc)
            }
            return { name, method: 0, crc32: crc, size: data.size, compressedSize: data.size, data }
        }
        return {
            name,
            method: 0,
            crc32: crc32(data),
            size: data.length,
            compressedSize: data.length,
            data,
        }
    }

    const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data
    const deflated = deflateRaw(bytes)
    return {
        name,
        method: 8,
        crc32: crc32(bytes),
        size: bytes.length,
        compressedSize: deflated.length,
        data: deflated,
    }
}

const SENTINEL = 0xffffffff
const MAX_ENTRIES = 0xfffe

/**
 * Lays out a ZIP as Blob parts, so data is never copied. Every header field is
 * pinned (§1.6.11.4): versions 2.0, flags `0x0800`, sizes and CRCs in the
 * local headers, no extra fields or comments. It never writes ZIP64, and
 * refuses (`limit`) 65,535 entries or a size or offset of 4 GB or more.
 */
export const assembleZip = (
    entries: readonly PreparedEntry[],
    { modified = DOS_EPOCH }: ZipOptions = {},
): BlobPart[] => {
    if (entries.length > MAX_ENTRIES) throw new ZipError('limit', 'entries')

    const encoder = new TextEncoder()
    const parts: BlobPart[] = []
    const central: Uint8Array<ArrayBuffer>[] = []
    const seen = new Set<string>()
    let offset = 0
    let centralSize = 0
    for (const entry of entries) {
        const key = entry.name.normalize('NFC')
        if (entry.name === '' || seen.has(key)) throw new ZipError('limit', `name ${entry.name}`)
        seen.add(key)
        const name = encoder.encode(entry.name)
        if (name.length > 0xffff) throw new ZipError('limit', 'name length')
        if (entry.size >= SENTINEL || entry.compressedSize >= SENTINEL || offset >= SENTINEL) {
            throw new ZipError('limit', 'size')
        }

        const local = new Uint8Array(30 + name.length)
        const lv = new DataView(local.buffer)
        lv.setUint32(0, 0x04034b50, true)
        lv.setUint16(4, 0x0014, true)
        lv.setUint16(6, 0x0800, true)
        lv.setUint16(8, entry.method, true)
        lv.setUint16(10, modified.dosTime, true)
        lv.setUint16(12, modified.dosDate, true)
        lv.setUint32(14, entry.crc32, true)
        lv.setUint32(18, entry.compressedSize, true)
        lv.setUint32(22, entry.size, true)
        lv.setUint16(26, name.length, true)
        local.set(name, 30)

        const record = new Uint8Array(46 + name.length)
        const cv = new DataView(record.buffer)
        cv.setUint32(0, 0x02014b50, true)
        cv.setUint16(4, 0x0014, true)
        cv.setUint16(6, 0x0014, true)
        cv.setUint16(8, 0x0800, true)
        cv.setUint16(10, entry.method, true)
        cv.setUint16(12, modified.dosTime, true)
        cv.setUint16(14, modified.dosDate, true)
        cv.setUint32(16, entry.crc32, true)
        cv.setUint32(20, entry.compressedSize, true)
        cv.setUint32(24, entry.size, true)
        cv.setUint16(28, name.length, true)
        cv.setUint32(42, offset, true)
        record.set(name, 46)

        parts.push(local, entry.data)
        central.push(record)
        offset += local.length + entry.compressedSize
        centralSize += record.length
    }
    if (offset >= SENTINEL || centralSize >= SENTINEL) throw new ZipError('limit', 'size')

    const end = new Uint8Array(22)
    const ev = new DataView(end.buffer)
    ev.setUint32(0, 0x06054b50, true)
    ev.setUint16(8, entries.length, true)
    ev.setUint16(10, entries.length, true)
    ev.setUint32(12, centralSize, true)
    ev.setUint32(16, offset, true)
    return [...parts, ...central, end]
}

/** Writes a ZIP from entries in order, as a Blob built from parts. */
export const buildZip = async (inputs: readonly ZipInput[], options: ZipOptions = {}) =>
    new Blob(assembleZip(await Promise.all(inputs.map(prepareEntry)), options), {
        type: 'application/zip',
    })
