import { LOCAL_HEADER_SIZE, localHeaderSize } from '../../zip/directory'
import { ZipError } from '../../zip/error'
import { ZipReader } from '../../zip/reader'
import { isObject, parseJsonBytes } from './json'
import type { PinnedSource, SourceEntry } from './plan'
import { NXSP_CAPS } from './read'

// `inspect`: a pinned file's metadata for the builder: its central directory with
// where each entry's data starts (from its local header, never the directory's extra length),
// its `project.json`, and its manifest and segments when they're there and inflate.

const bytesOf = async (blob: Blob, start: number, end: number) =>
    new Uint8Array(await blob.slice(start, end).arrayBuffer())

/** Inspects a pinned `.nxsp`; throws `ZipError` when it isn't a readable ZIP with a `project.json`. */
export const inspectNxsp = async (
    file: Blob,
    pinned: { token: string; role: 'target' | 'base'; fingerprint: string },
): Promise<PinnedSource> => {
    const reader = await ZipReader.open(file)
    if (reader.recovered) throw new ZipError('directory')
    const entries: SourceEntry[] = []
    for (const entry of reader.entries) {
        if (entry.method !== 0 && entry.method !== 8) throw new ZipError('unsupported', entry.name)
        const fixed = await bytesOf(file, entry.localOffset, entry.localOffset + LOCAL_HEADER_SIZE)
        entries.push({
            index: entry.index,
            name: entry.name,
            method: entry.method,
            crc32: entry.crc32,
            compressedSize: entry.compressedSize,
            uncompressedSize: entry.size,
            dataOffset: entry.localOffset + localHeaderSize(fixed),
        })
    }

    const json = async (name: unknown, cap: number) => {
        const entry = typeof name === 'string' ? reader.get(name) : undefined
        if (!entry) throw new ZipError('directory', `no ${String(name)}`)
        return parseJsonBytes(await reader.read(entry, { maxSize: cap }))
    }
    const projectJson = await json('project.json', NXSP_CAPS.project)
    const history = isObject(projectJson) ? projectJson.history : undefined
    let manifest: PinnedSource['manifest']
    if (isObject(history)) {
        const segments: unknown[] = []
        for (const name of Array.isArray(history.segments) ? (history.segments as unknown[]) : [])
            segments.push(await json(name, NXSP_CAPS.manifest))
        manifest = { manifest: await json(history.manifest, NXSP_CAPS.manifest), segments }
    }
    return {
        ...pinned,
        size: file.size,
        entries,
        projectJson,
        ...(manifest ? { manifest } : {}),
    }
}
