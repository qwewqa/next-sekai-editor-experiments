import { verifyChunk, type VerifiedChunk } from '../chunkVerify'
import { readMeta } from '../db'
import { fromHex16, toHex } from '../hash'
import { isObject } from '../nxsp/json'
import type { PinnedSource } from '../nxsp/plan'
import { putChunk } from '../putChunk'
import { sourceParts } from './assert'
import { stillBad, type SaveStore } from './bodies'
import { knownDamage } from './predicate'

// Known damage put right from the chain's own file (SP-1, L1): a stored chunk a build found bad
// (some chain's `badChunks`) that still fails, when the append source holds it, is stored again
// from the source's bytes once they inflate and hash to its key, through `putChunk`, which
// replaces only a row that's missing or fails its CRC. Content-addressed, so it can only repair:
// any other writer of that key writes the same bytes. Runs after a build is checked, so it never
// changes what the build wrote; a repair that fails leaves storing as it was and is only logged.
// Roots and kind nodes aren't put back here: a root's row carries media read from its header.

/** Where the source's chunks are in its file: `chunks.bin`'s data when STORE, by chunk. */
const sourceChunks = (source: PinnedSource) => {
    if (!source.manifest) return
    const project = isObject(source.projectJson) ? source.projectJson : undefined
    const history = project && isObject(project.history) ? project.history : undefined
    const found = source.entries.filter((entry) => entry.name === history?.chunks)
    const entry = found.length === 1 ? found[0] : undefined
    // A DEFLATE `chunks.bin` (an OS re-zip) would have to be inflated whole: left as it is.
    if (entry?.method !== 0 || entry.compressedSize !== entry.uncompressedSize) return
    const places = new Map<string, { start: number; end: number }>()
    for (const part of sourceParts(source))
        for (const [hash, offset, length] of part.chunks)
            if (offset + length <= entry.uncompressedSize)
                places.set(hash, {
                    start: entry.dataOffset + offset,
                    end: entry.dataOffset + offset + length,
                })
    return places
}

/** Puts back known-bad stored chunks the source holds; resolves the hashes stored again. */
export const repairFromSource = async (
    store: SaveStore,
    source: PinnedSource,
    file: Blob,
): Promise<string[]> => {
    const known = await knownDamage(store)
    if (!known.size) return []
    const places = sourceChunks(source)
    if (!places) return []
    const held = [...known].filter((hex) => places.has(hex))
    if (!held.length) return []
    const bad = await stillBad(store, held)
    const chunks: VerifiedChunk[] = []
    for (const hex of held) {
        const place = places.get(hex)
        if (!bad.has(hex) || !place) continue
        try {
            const stored = new Uint8Array(await file.slice(place.start, place.end).arrayBuffer())
            chunks.push(await verifyChunk({ hash: fromHex16(hex), stored }))
        } catch (error) {
            console.error('A chunk in the chain’s file could not be put back', hex, error)
        }
    }
    if (!chunks.length) return []
    const put = await store.write(
        ['chunks', 'meta'],
        async (tx) => {
            const day = (await readMeta(tx, 'daysOfUse')) ?? 0
            const done: string[] = []
            for (const chunk of chunks) {
                await putChunk(tx, chunk, day)
                done.push(toHex(chunk.hash))
            }
            return done
        },
        { pauseOnFailure: false },
    )
    console.info('Damage in storage put right from the chain’s file', put)
    return put
}
