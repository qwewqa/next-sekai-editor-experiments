import { crc32 } from 'node:zlib'
import { deflateRaw, inflateRaw } from 'pako'

/**
 * A ZIP with zero timestamps (the DOS date is 1980-01-01), in the order given.
 * Each entry is { name, data, method: 'store' | 'deflate' }.
 */
export function createZip(entries) {
    const local = []
    const central = []
    let offset = 0
    for (const { name, data, method } of entries) {
        const nameBytes = Buffer.from(name)
        const stored = method === 'deflate' ? deflateRaw(data, { level: 9 }) : data
        const header = Buffer.alloc(30)
        header.writeUInt32LE(0x04034b50, 0)
        header.writeUInt16LE(20, 4)
        header.writeUInt16LE(0x800, 6)
        header.writeUInt16LE(method === 'deflate' ? 8 : 0, 8)
        header.writeUInt16LE(33, 12)
        header.writeUInt32LE(crc32(data), 14)
        header.writeUInt32LE(stored.length, 18)
        header.writeUInt32LE(data.length, 22)
        header.writeUInt16LE(nameBytes.length, 26)
        local.push(header, nameBytes, stored)
        const directory = Buffer.alloc(46)
        directory.writeUInt32LE(0x02014b50, 0)
        directory.writeUInt16LE(20, 4)
        header.copy(directory, 6, 4, 30)
        directory.writeUInt32LE(offset, 42)
        central.push(directory, nameBytes)
        offset += header.length + nameBytes.length + stored.length
    }
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(entries.length, 8)
    end.writeUInt16LE(entries.length, 10)
    end.writeUInt32LE(
        central.reduce((size, part) => size + part.length, 0),
        12,
    )
    end.writeUInt32LE(offset, 16)
    return Buffer.concat([...local, ...central, end])
}

/** The entries of a ZIP made by createZip (or any ZIP without ZIP64), by name, in directory order. */
export function readZip(bytes) {
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let end = buffer.length - 22
    while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end--
    if (end < 0) throw new Error('Invalid ZIP')
    const count = buffer.readUInt16LE(end + 10)
    const entries = new Map()
    let at = buffer.readUInt32LE(end + 16)
    for (let i = 0; i < count; i++) {
        const method = buffer.readUInt16LE(at + 10)
        const size = buffer.readUInt32LE(at + 20)
        const nameLength = buffer.readUInt16LE(at + 28)
        const extraLength = buffer.readUInt16LE(at + 30)
        const commentLength = buffer.readUInt16LE(at + 32)
        const offset = buffer.readUInt32LE(at + 42)
        const name = buffer.toString('utf8', at + 46, at + 46 + nameLength)
        const start =
            offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28)
        const stored = buffer.subarray(start, start + size)
        entries.set(name, method === 8 ? Buffer.from(inflateRaw(stored)) : Buffer.from(stored))
        at += 46 + nameLength + extraLength + commentLength
    }
    return entries
}
