import { CHUNK_CAP, inflateStrict, verifyChunk, type VerifiedChunk } from '../chunkVerify'
import { NO_USE_DAY, type UseDay } from '../days'
import { hashKey, readMeta } from '../db'
import { equalBytes, fromHex16, hash16, sha256, toHex } from '../hash'
import type { KvTx } from '../kv/types'
import { isObject } from '../nxsp/json'
import type { PinnedSource } from '../nxsp/plan'
import { putChunk } from '../putChunk'
import { canonicalBytes, type RecordValue } from '../records/canonical'
import {
    isChunkRowIntact,
    nodeJsonFromRow,
    packHashes,
    rootJsonFromRow,
    storedDay,
    type NodeRow,
    type NodesRow,
    type RootRow,
} from '../records/rows'
import { checkHeader, kindNames, type KindName } from '../records/schema'
import { checkNode, checkRoot, headerMedia } from '../records/snapshot'
import { isReadableRootVersion, mediaKinds } from '../records/unknownValues'
import { sourceParts } from './assert'
import { stillBad, type SaveStore } from './bodies'
import { fromSource, isStoredMediaWhole } from './media'
import { knownDamage } from './predicate'

// Known damage put right from the chain's own file: a stored body a build found
// bad (some chain's `badChunks`) that still fails, when the append source holds it, is stored
// again from the source's bytes once they check against its key: a chunk must inflate and hash to
// it (`verifyChunk`, then `putChunk`), a root or kind node's JSON form must pass its schema and
// hash to it, a media item's bytes must hash to its whole `sha256`. Content-addressed, so it can
// only repair: any other writer of that key writes the same content. Only a row that's missing or
// fails its own check is replaced. A node or root is stored only once everything it reaches is in
// storage and whole, so a repair never stores a state that isn't whole. A root's media come from
// its header chunk, read back from storage once whole. Runs after a build is checked, so it never
// changes what the build wrote; a repair that fails leaves storing as it was and is only logged.

/** A media item read whole for a repair at most this large; a larger one stays as it is. */
export const REPAIR_MEDIA_CAP = 64 * 1024 * 1024

/** Where the source's chunks are in its file: `chunks.bin`'s data when STORE, by chunk. */
const sourceChunks = (source: PinnedSource) => {
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

/** The source's roots and kind nodes, JSON forms by hex. */
const sourceRecords = (source: PinnedSource) => {
    const roots = new Map<string, RecordValue[]>()
    const nodes = new Map<string, RecordValue[]>()
    for (const part of sourceParts(source)) {
        for (const [hex, json] of Object.entries(part.roots)) roots.set(hex, json)
        for (const [hex, json] of Object.entries(part.nodes)) nodes.set(hex, json)
    }
    return { roots, nodes }
}

const day = async (tx: KvTx) => (await readMeta(tx, 'daysOfUse')) ?? NO_USE_DAY

const keptDay = (old: unknown, fallback: UseDay) =>
    storedDay(isObject(old) ? old.day : undefined, fallback)

const repairChunks = async (
    store: SaveStore,
    source: PinnedSource,
    file: Blob,
    bad: ReadonlySet<string>,
) => {
    const places = sourceChunks(source)
    if (!places) return []
    const chunks: VerifiedChunk[] = []
    for (const hex of bad) {
        const place = places.get(hex)
        if (!place) continue
        try {
            const stored = new Uint8Array(await file.slice(place.start, place.end).arrayBuffer())
            chunks.push(await verifyChunk({ hash: fromHex16(hex), stored }))
        } catch (error) {
            console.error("A chunk in the chain's file could not be put back", hex, error)
        }
    }
    if (!chunks.length) return []
    return store.write(
        ['chunks', 'meta'],
        async (tx) => {
            const today = await day(tx)
            const done: string[] = []
            for (const chunk of chunks) {
                await putChunk(tx, chunk, today)
                done.push(toHex(chunk.hash))
            }
            return done
        },
        { pauseOnFailure: false },
    )
}

/** A node's children, a root's header and kind nodes: what its row's `refs` start with. */
const childrenOf = (json: readonly RecordValue[]): string[] =>
    typeof json[0] === 'number'
        ? [json[1] as string, ...(json[2] as [string, string][]).map(([, node]) => node)]
        : (json[2] as string[])

/**
 * Of `hashes` and everything they reach through stored kind nodes, those storage lacks or holds
 * bad: a record whose answer is empty is whole.
 */
const closureBad = async (store: SaveStore, hashes: readonly string[]) => {
    const reached = new Set(hashes)
    let level = [...reached]
    // Two levels of nodes at most under a root, as `loadBodies` reads them.
    for (let depth = 0; depth < 3 && level.length; depth++) {
        const rows = await store.read(['nodes'], async (tx) => {
            const out: unknown[] = []
            for (const hex of level) out.push(await tx.get('nodes', hashKey(fromHex16(hex))))
            return out
        })
        const next: string[] = []
        for (const row of rows) {
            const value = row as NodesRow | undefined
            if (value?.t !== 'node') continue
            try {
                for (const child of nodeJsonFromRow(value)[2] as string[])
                    if (!reached.has(child)) {
                        reached.add(child)
                        next.push(child)
                    }
            } catch {
                // A row that doesn't read is bad itself: `stillBad` says so.
            }
        }
        level = next
    }
    return stillBad(store, [...reached])
}

/** A stored row's JSON form, or undefined when it doesn't read. */
const storedJson = (row: unknown) => {
    const value = row as NodesRow | undefined
    try {
        if (value?.t === 'root') return rootJsonFromRow(value)
        if (value?.t === 'node') return nodeJsonFromRow(value)
    } catch {
        return
    }
}

/** The media a root's header references, from its header chunk as storage holds it, whole. */
const headerMediaOf = async (store: SaveStore, header: string) => {
    const row = await store.read(['chunks'], (tx) => tx.get('chunks', hashKey(fromHex16(header))))
    const value = row as { bytes?: unknown; crc32?: unknown } | undefined
    if (
        !(value?.bytes instanceof Uint8Array) ||
        typeof value.crc32 !== 'number' ||
        !isChunkRowIntact(fromHex16(header), { bytes: value.bytes, crc32: value.crc32 })
    )
        return
    const canonical = inflateStrict(value.bytes, CHUNK_CAP)
    if (!equalBytes(await hash16(canonical), fromHex16(header))) return
    const json = JSON.parse(new TextDecoder().decode(canonical)) as unknown
    checkHeader(json)
    return headerMedia(json as RecordValue[])
}

type RowWithoutDay = Omit<RootRow, 'day'> | Omit<NodeRow, 'day'>

/** A root or kind node's row from its JSON form, checked against its key; undefined when it fails. */
const recordRow = async (
    store: SaveStore,
    hex: string,
    json: RecordValue[],
): Promise<RowWithoutDay | undefined> => {
    const bytes = canonicalBytes(json)
    if (!equalBytes(await hash16(bytes), fromHex16(hex))) return
    if (typeof json[0] === 'number') {
        if (!isReadableRootVersion(json[0])) return
        checkRoot(json)
        const [v, header, kinds, noteCount] = json as [number, string, [string, string][], number]
        const media = await headerMediaOf(store, header)
        if (!media) return
        return {
            t: 'root',
            v,
            kinds: kinds.map(([name]) => name),
            noteCount,
            refs: packHashes([
                fromHex16(header),
                ...kinds.map(([, node]) => fromHex16(node)),
                ...media,
            ]),
            size: bytes.length,
        } satisfies Omit<RootRow, 'day'>
    }
    const kind = json[0]
    if (!kindNames.includes(kind as KindName)) return
    checkNode(json, kind as KindName)
    return {
        t: 'node',
        kind: kind as string,
        depth: json[1] as 0 | 1,
        refs: packHashes((json[2] as string[]).map(fromHex16)),
        size: bytes.length,
    } satisfies Omit<NodeRow, 'day'>
}

/**
 * Bad roots and kind nodes the source holds, bottom-up: depth-0 nodes, depth-1 nodes, then roots,
 * each once everything it reaches is whole in storage.
 */
const repairRecords = async (store: SaveStore, source: PinnedSource, bad: ReadonlySet<string>) => {
    const { roots, nodes } = sourceRecords(source)
    const levels: [string, RecordValue[]][][] = [[], [], []]
    for (const hex of bad) {
        const node = nodes.get(hex)
        const root = roots.get(hex)
        if (node) levels[node[1] === 0 ? 0 : 1]?.push([hex, node])
        else if (root) levels[2]?.push([hex, root])
    }
    const done: string[] = []
    for (const level of levels) {
        const rows: [string, RowWithoutDay][] = []
        for (const [hex, json] of level) {
            try {
                if ((await closureBad(store, childrenOf(json))).size) continue
                const row = await recordRow(store, hex, json)
                if (row) rows.push([hex, row])
            } catch (error) {
                console.error("A record in the chain's file could not be put back", hex, error)
            }
        }
        if (!rows.length) continue
        const put = await store.write(
            ['nodes', 'meta'],
            async (tx) => {
                const today = await day(tx)
                const out: string[] = []
                for (const [hex, row] of rows) {
                    const key = hashKey(fromHex16(hex))
                    const old = await tx.get('nodes', key)
                    // A row whose form is the one checked here is whole already: kept, with its day.
                    const json = old === undefined ? undefined : storedJson(old)
                    const ours = storedJson({ ...row, day: today })
                    if (json && ours && equalBytes(canonicalBytes(json), canonicalBytes(ours)))
                        continue
                    await tx.put('nodes', { ...row, day: keptDay(old, today) }, key)
                    out.push(hex)
                }
                return out
            },
            { pauseOnFailure: false },
        )
        done.push(...put)
    }
    return done
}

/** Known-bad media the source holds as a STORE entry, stored again once it hashes to its `sha256`. */
const repairMedia = async (
    store: SaveStore,
    source: PinnedSource,
    file: Blob,
    known: ReadonlySet<string>,
) => {
    const items: { hash: string; row: Record<string, unknown> }[] = []
    for (const kind of mediaKinds) {
        const project = isObject(source.projectJson) ? source.projectJson : undefined
        const form =
            kind === 'bgm'
                ? project?.bgm
                : isObject(project?.metadata)
                  ? project.metadata[kind]
                  : undefined
        const sha = isObject(form) && typeof form.sha256 === 'string' ? form.sha256 : undefined
        const hash = sha?.slice(0, 32)
        if (!hash || !known.has(hash) || items.some((each) => each.hash === hash)) continue
        const found = fromSource(source, kind, hash)
        const entry = found?.entry
        if (
            !found ||
            entry?.method !== 0 ||
            entry.compressedSize !== entry.uncompressedSize ||
            entry.uncompressedSize > REPAIR_MEDIA_CAP
        )
            continue
        if (await isStoredMediaWhole(store, hash)) continue
        try {
            const end = entry.dataOffset + entry.uncompressedSize
            const bytes = new Uint8Array(await file.slice(entry.dataOffset, end).arrayBuffer())
            const digest = await sha256(bytes)
            if (toHex(digest) !== found.sha256) continue
            items.push({
                hash,
                row: {
                    blob: new Blob([bytes], found.type ? { type: found.type } : {}),
                    sha256: digest,
                    size: bytes.byteLength,
                    type: found.type,
                    ...(found.filename === undefined ? {} : { filename: found.filename }),
                    kind,
                },
            })
        } catch (error) {
            console.error("A media item in the chain's file could not be put back", hash, error)
        }
    }
    if (!items.length) return []
    return store.write(
        ['media', 'meta'],
        async (tx) => {
            const today = await day(tx)
            const done: string[] = []
            for (const { hash, row } of items) {
                const key = hashKey(fromHex16(hash))
                const old = await tx.get('media', key)
                // A Blob the browser refuses (WebKit's private windows) leaves the row as it was.
                if (await tx.tryPut('media', { ...row, day: keptDay(old, today) }, key))
                    done.push(hash)
            }
            return done
        },
        { pauseOnFailure: false },
    )
}

/**
 * Puts back known-bad stored bodies the source holds; resolves the hashes stored again. `bad`
 * names them (Check File and History's findings); without it, every chain's `badChunks`.
 */
export const repairFromSource = async (
    store: SaveStore,
    source: PinnedSource,
    file: Blob,
    bad?: ReadonlySet<string>,
): Promise<string[]> => {
    const known = bad ?? (await knownDamage(store))
    if (!known.size) return []
    const still = source.manifest ? await stillBad(store, [...known]) : new Set<string>()
    const done: string[] = []
    // Each kind on its own: one that fails leaves the others to be put right.
    const step = async (kind: string, run: () => Promise<string[]>) => {
        try {
            done.push(...(await run()))
        } catch (error) {
            console.error(`Putting ${kind} in storage right from the chain's file failed`, error)
        }
    }
    if (still.size) {
        await step('chunks', () => repairChunks(store, source, file, still))
        await step('records', () => repairRecords(store, source, still))
    }
    await step('media', () => repairMedia(store, source, file, known))
    if (done.length) console.info("Damage in storage put right from the chain's file", done)
    return done
}
