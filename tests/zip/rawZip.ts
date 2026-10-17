import { deflateRawSync } from 'node:zlib'
import { crc32 } from '../../src/zip'

// A deliberately flexible ZIP builder for the reader's tests: ZIP64 fields, flags and
// damage that the real writer never produces.

export type RawEntry = {
    name: string | Uint8Array
    data: Uint8Array
    method?: 0 | 8
    flags?: number
    /** Writes sizes and offset as ZIP64 sentinels with the real values in an extra field. */
    zip64?: boolean
    /** Overrides for the central directory record only. */
    central?: { crc32?: number; size?: number; compressedSize?: number; method?: number }
    /** The stored bytes, when they should differ from what `data` compresses to. */
    stored?: Uint8Array
}

export type RawOptions = {
    /** Writes the end record with ZIP64 sentinels and a ZIP64 end record and locator. */
    zip64End?: boolean
    comment?: Uint8Array
    /** Appended after the end record. */
    trailing?: Uint8Array
}

const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff]
const u32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]
const u64 = (n: number) => [...u32(n % 2 ** 32), ...u32(Math.floor(n / 2 ** 32))]

export const concat = (...parts: (Uint8Array | number[])[]) => {
    const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
    let at = 0
    for (const part of parts) {
        out.set(part, at)
        at += part.length
    }
    return out
}

export const rawZip = (entries: RawEntry[], options: RawOptions = {}) => {
    const locals: Uint8Array[] = []
    const centrals: Uint8Array[] = []
    let offset = 0
    for (const entry of entries) {
        const name =
            typeof entry.name === 'string' ? new TextEncoder().encode(entry.name) : entry.name
        const method = entry.method ?? 8
        const stored = entry.stored ?? (method === 8 ? deflateRawSync(entry.data) : entry.data)
        const crc = crc32(entry.data)
        const flags = entry.flags ?? 0x0800
        const size = entry.data.length
        const csize = stored.length

        const localExtra = entry.zip64 ? [...u16(1), ...u16(16), ...u64(size), ...u64(csize)] : []
        locals.push(
            concat(
                [
                    ...u32(0x04034b50),
                    ...u16(45),
                    ...u16(flags),
                    ...u16(method),
                    ...u16(0),
                    ...u16(33),
                ],
                u32(crc),
                u32(entry.zip64 ? 0xffffffff : csize),
                u32(entry.zip64 ? 0xffffffff : size),
                [...u16(name.length), ...u16(localExtra.length)],
                name,
                localExtra,
                stored,
            ),
        )

        const c = entry.central ?? {}
        const centralExtra = entry.zip64
            ? [...u16(1), ...u16(24), ...u64(size), ...u64(csize), ...u64(offset)]
            : []
        centrals.push(
            concat(
                [
                    ...u32(0x02014b50),
                    ...u16(45),
                    ...u16(45),
                    ...u16(flags),
                    ...u16(c.method ?? method),
                ],
                [...u16(0), ...u16(33)],
                u32(c.crc32 ?? crc),
                u32(entry.zip64 ? 0xffffffff : (c.compressedSize ?? csize)),
                u32(entry.zip64 ? 0xffffffff : (c.size ?? size)),
                [...u16(name.length), ...u16(centralExtra.length), ...u16(0), ...u16(0), ...u16(0)],
                [...u32(0), ...u32(entry.zip64 ? 0xffffffff : offset)],
                name,
                centralExtra,
            ),
        )
        offset += locals.at(-1)!.length
    }

    const directory = concat(...centrals)
    const comment = options.comment ?? new Uint8Array(0)
    const parts: (Uint8Array | number[])[] = [...locals, directory]
    if (options.zip64End) {
        const zip64EndAt = offset + directory.length
        parts.push(
            [...u32(0x06064b50), ...u64(44), ...u16(45), ...u16(45), ...u32(0), ...u32(0)],
            [
                ...u64(entries.length),
                ...u64(entries.length),
                ...u64(directory.length),
                ...u64(offset),
            ],
            [...u32(0x07064b50), ...u32(0), ...u64(zip64EndAt), ...u32(1)],
            [...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(0xffff), ...u16(0xffff)],
            [...u32(0xffffffff), ...u32(0xffffffff), ...u16(comment.length)],
        )
    } else {
        parts.push(
            [
                ...u32(0x06054b50),
                ...u16(0),
                ...u16(0),
                ...u16(entries.length),
                ...u16(entries.length),
            ],
            [...u32(directory.length), ...u32(offset), ...u16(comment.length)],
        )
    }
    parts.push(comment, options.trailing ?? [])
    return concat(...parts)
}

export const utf8 = (text: string) => new TextEncoder().encode(text)
