import { ZipError, ZipReader, isIgnoredEntry } from '../zip'

// Open classifies by content, never by extension (§1.5.2). Only the first 64 bytes are read to tell
// audio and ZIP from the rest, so a large file is never read whole just to identify it.

export const HEAD_SIZE = 64

/** What a ZIP is: a project file, an archive of project files, a Sonolus package, or neither. */
export type ZipKind = 'project' | 'archive' | 'package' | 'other'

export type Detection =
    | { kind: 'audio' }
    | { kind: 'zip'; zip: ZipKind }
    /** Anything else: Open reads it whole and tries level data, USC, ChCy and SUS. */
    | { kind: 'data' }

const startsWith = (bytes: Uint8Array, signature: readonly number[], at = 0) =>
    signature.every((byte, i) => bytes[at + i] === byte)

export const isZipHead = (head: Uint8Array) =>
    startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06])

/**
 * An MPEG audio frame header whose fields validate: sync, then a valid version,
 * layer, bitrate index (not `1111`) and sample-rate index (not `11`), and no
 * reserved emphasis. A bare `FF Ex` is not enough, and `FF FE` (Layer I with a
 * CRC, which no file uses) is left out because it is the UTF-16 LE byte-order mark.
 */
export const isMpegHeader = (head: Uint8Array, at = 0) => {
    const [b0, b1, b2, b3] = [head[at], head[at + 1], head[at + 2], head[at + 3]]
    if (b0 !== 0xff || b1 === undefined || b2 === undefined || b3 === undefined) return false
    if ((b1 & 0xe0) !== 0xe0 || b1 === 0xfe) return false
    if (((b1 >> 3) & 3) === 1) return false // reserved version
    if (((b1 >> 1) & 3) === 0) return false // reserved layer
    if (b2 >> 4 === 0xf) return false // bad bitrate
    if (((b2 >> 2) & 3) === 3) return false // reserved sample rate
    return (b3 & 3) !== 2 // reserved emphasis
}

/** Audio by magic number: MP3, Ogg, WAV, FLAC, M4A/MP4 and WebM. */
export const isAudioHead = (head: Uint8Array) =>
    startsWith(head, [0x49, 0x44, 0x33]) || // ID3
    isMpegHeader(head) ||
    startsWith(head, [0x4f, 0x67, 0x67, 0x53]) || // OggS
    (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x41, 0x56, 0x45], 8)) || // RIFF…WAVE
    startsWith(head, [0x66, 0x4c, 0x61, 0x43]) || // fLaC
    startsWith(head, [0x66, 0x74, 0x79, 0x70], 4) || // ftyp
    startsWith(head, [0x1a, 0x45, 0xdf, 0xa3]) // WebM

/**
 * What a ZIP without a project file is, from its entry names (NFC, ignored
 * entries already left out): `manifest.json` or `.nxsp` entries make an
 * archive, which the web only names; `sonolus/` entries a collection package.
 */
export const classifyZipNames = (names: readonly string[]): Exclude<ZipKind, 'project'> => {
    if (names.includes('manifest.json') || names.some((name) => name.endsWith('.nxsp'))) {
        return 'archive'
    }
    if (names.some((name) => name.startsWith('sonolus/'))) return 'package'
    return 'other'
}

const PROJECT_JSON_CAP = 1024 * 1024

/** Classifies a ZIP: `project.json` with `"format": "nxsp"` is a project file. */
export const detectZip = async (file: Blob): Promise<ZipKind> => {
    let reader: ZipReader
    try {
        reader = await ZipReader.open(file)
    } catch (error) {
        if (error instanceof ZipError) return 'other'
        throw error
    }

    const kept = reader.entries.filter((entry) => !isIgnoredEntry(entry))
    const project = reader.get('project.json')
    if (project && !project.isDirectory) {
        try {
            const json: unknown = JSON.parse(
                new TextDecoder().decode(await reader.read(project, { maxSize: PROJECT_JSON_CAP })),
            )
            if (typeof json === 'object' && json !== null && 'format' in json) {
                if (json.format === 'nxsp') return 'project'
            }
        } catch (error) {
            // A project.json that cannot be read is not one this check can vouch for.
            if (!(error instanceof ZipError || error instanceof SyntaxError)) throw error
        }
    }
    return classifyZipNames(kept.map((entry) => entry.key))
}

/** Classifies a picked file by its content. The file's MIME type counts for audio, as it always has. */
export const detectContent = async (file: Blob): Promise<Detection> => {
    if (file.type.startsWith('audio/')) return { kind: 'audio' }

    const head = new Uint8Array(await file.slice(0, HEAD_SIZE).arrayBuffer())
    if (isZipHead(head)) return { kind: 'zip', zip: await detectZip(file) }
    if (isAudioHead(head)) return { kind: 'audio' }
    return { kind: 'data' }
}
