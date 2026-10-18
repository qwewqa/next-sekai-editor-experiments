import { crc32 } from './crc32'
import { END_TAIL_SIZE, findEnd, parseZip64End, ZIP64_END_SIZE } from './directory'
import { ZipError } from './error'

const bytesOf = async (source: Blob, start: number, end: number) =>
    new Uint8Array(await source.slice(start, end).arrayBuffer())

/**
 * A ZIP's `<cd>` (§1.6.11.2): the CRC-32, as 8 lowercase hex characters, of the central directory's
 * bytes, from the offset and size the end record gives (the ZIP64 end record's when the locator is
 * there), with no end record included.
 */
export const centralDirectoryCrc = async (source: Blob) => {
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
    const crc = crc32(await bytesOf(source, end.cdOffset, end.cdOffset + end.cdSize))
    return crc.toString(16).padStart(8, '0')
}

/** A ZIP's fingerprint (§1.6.11.2): `zip:<size>:<lastModified>:<cd>`. */
export const zipFingerprint = async (source: Blob, lastModified: number) =>
    `zip:${source.size}:${Math.trunc(lastModified)}:${await centralDirectoryCrc(source)}`
