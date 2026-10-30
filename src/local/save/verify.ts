import { isNotReadable } from '../../platform/fingerprint'
import { ZipReader } from '../../zip/reader'
import { equalBytes, fromHex16, hash16, sha256, toHex } from '../hash'
import type { PlannedChunk } from '../nxsp/build'
import { gunzipLevel, gzipStoredCap } from '../nxsp/gzip'
import { isObject, parseJsonBytes } from '../nxsp/json'
import { NXSP_CAPS } from '../nxsp/read'
import { scpEntries } from '../nxsp/scp'
import { canonicalBytes, type RecordValue } from '../records/canonical'
import { chunkCrc32 } from '../records/rows'

// The post-build check: every `.nxsp` built is re-opened before
// it's handed over or written: the central directory and every entry's CRC, the media's SHA-256,
// every root and node hashing to its name, and every chunk the plan took from storage by its
// stored CRC over its key and the bytes at its offset. Chunks aren't inflated or hashed again.

export class BuiltFileError extends Error {
    override name = 'BuiltFileError'
}

const fail = (message: string): never => {
    throw new BuiltFileError(message)
}

const mediaForms = (project: Record<string, unknown>) => {
    const metadata = isObject(project.metadata) ? project.metadata : {}
    return [project.bgm, metadata.cover, metadata.preview].filter(isObject)
}

/** A read failure that isn't the built file's: a pinned file changed under it, never damage. */
const unlessNotReadable = (error: unknown, message: string): never => {
    if (isNotReadable(error)) throw error
    return fail(message)
}

/**
 * Checks a built file; throws `BuiltFileError` naming what's wrong, or a pinned file's
 * `NotReadableError` (it changed under the built file's ranges) as it is.
 */
export const checkBuilt = async (file: Blob, storageChunks: readonly PlannedChunk[]) => {
    const reader = await ZipReader.open(file).catch((error: unknown) =>
        unlessNotReadable(error, 'not a readable ZIP'),
    )
    if (reader.recovered || reader.ambiguous.size) fail('its central directory')
    // Every entry read once: its CRC is checked by the read.
    const data = new Map<string, Uint8Array>()
    for (const entry of reader.entries) {
        try {
            const cap =
                entry.name === 'level.json.gz'
                    ? gzipStoredCap(NXSP_CAPS.level)
                    : NXSP_CAPS.chunksBin
            data.set(entry.name, await reader.read(entry, { maxSize: cap }))
        } catch (error) {
            unlessNotReadable(error, `${entry.name} does not read`)
        }
    }
    const json = (name: unknown) => {
        const bytes = typeof name === 'string' ? data.get(name) : undefined
        return bytes ? parseJsonBytes(bytes) : fail(`no ${String(name)}`)
    }
    const project = json('project.json')
    if (!isObject(project)) return fail('project.json')
    if (project.level !== 'level.json.gz' || data.has('level.json')) fail('level payload')
    const levelEntry = reader.get('level.json.gz')
    if (levelEntry?.method !== 0) fail('level.json.gz must be stored')
    try {
        const level = parseJsonBytes(
            gunzipLevel(data.get('level.json.gz') ?? fail('no level.json.gz'), NXSP_CAPS.level),
        )
        if (
            !isObject(level) ||
            !Array.isArray(level.entities) ||
            typeof level.bgmOffset !== 'number' ||
            Object.keys(level).some((key) => key !== 'entities' && key !== 'bgmOffset')
        )
            fail('level data')
        const expected = scpEntries(project)
        for (const [name, value] of expected) {
            if (JSON.stringify(json(name)) !== JSON.stringify(value))
                fail(`${name}: its project projection`)
            if (reader.get(name)?.method !== 8) fail(`${name}: its ZIP method`)
        }
        for (const name of data.keys())
            if (name.startsWith('sonolus/') && !expected.has(name))
                fail(`${name}: unexpected package entry`)
    } catch (error) {
        unlessNotReadable(error, error instanceof Error ? error.message : 'package projection')
    }
    for (const form of mediaForms(project)) {
        if (typeof form.file !== 'string') continue
        const bytes = data.get(form.file) ?? fail(`no ${form.file}`)
        if (bytes.length !== form.size) fail(`${form.file}: its size`)
        if (toHex(await sha256(bytes)) !== form.sha256) fail(`${form.file}: its SHA-256`)
    }
    const history = project.history
    if (!isObject(history)) return
    const segments: unknown[] = Array.isArray(history.segments) ? history.segments : []
    const names = [...segments, history.manifest]
    for (const name of names) {
        const part = json(name)
        if (!isObject(part)) return fail(String(name))
        for (const map of [part.roots, part.nodes])
            for (const [key, value] of Object.entries(isObject(map) ? map : {}))
                if (
                    !equalBytes(
                        await hash16(canonicalBytes(value as RecordValue[])),
                        fromHex16(key),
                    )
                )
                    fail(`${key} does not hash to its name`)
    }
    const chunks = data.get(history.chunks as string) ?? fail('no chunks.bin')
    for (const { hash, offset, length, crc32 } of storageChunks)
        if (
            offset + length > chunks.length ||
            chunkCrc32(fromHex16(hash), chunks.subarray(offset, offset + length)) !== crc32
        )
            fail(`chunk ${hash} is not the stored chunk`)
}
