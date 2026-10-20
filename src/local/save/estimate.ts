import { captureEntryDescription } from '../../history/operations'
import { hashKey } from '../db'
import { fromHex16, toHex } from '../hash'
import { unpackHashes, type NodesRow } from '../records/rows'
import type { SaveStore } from './bodies'
import { CUT_STORES, readCut } from './cut'
import { chainRows, ModelError } from './model'

// The Save dialogs' size preview (Part 1 §1.4.7; owner, 2026-10-16): `estimateSaveSize`, from
// stored sizes, never inflating or hashing a body. For the rows the write would hold, each
// distinct root's and node's row `size` and each chunk's stored length; the media rows' sizes;
// the manifest by a per-entry and per-record estimate, deflated; `level.json` from the head's
// records the same way. Cached per chain by the saved session and its `lastSeq`.

/** Sizes in bytes; the dialog's total adds `base` and the ticked rows. */
export type SaveSizeEstimate = {
    /**
     * History's steps: the chain's rows, as Go To and the Timeline count them (continue entries and
     * rows not kept included; the write's own `save` entry not yet). A fork's Timeline goes on into
     * its parent's chain, which a file does not hold: the count is the chain's own.
     */
    steps: number
    /** The manifest, segments and `chunks.bin`. */
    history: number
    /** The head's BGM; absent without one in storage. */
    bgm?: number
    /** What every write holds: `project.json`, `level.json`, the head's cover and preview audio. */
    base: number
}

/** Constants fixed on the generated large chart and the golden chart (§1.4.7). */
export const ESTIMATE = {
    /** An entry's JSON framing beyond its captured description, before deflate. */
    entryBytes: 150,
    /** A root's or node's key and framing in a part's map. */
    recordOverhead: 40,
    /** A `chunks` index item. */
    indexBytes: 52,
    /** How much of the manifest's JSON deflate keeps (its hashes repeat). */
    manifestDeflate: 0.15,
    /** `level.json` deflated, by the head's canonical record bytes. */
    levelRatio: 0.21,
    /** `project.json` without its ancestors, and the ZIP's headers. */
    projectBytes: 700,
    /** Each ancestor id in `revision.ancestors`. */
    ancestorBytes: 40,
}

const cache = new Map<
    string,
    { sessionId: string | undefined; lastSeq: number; estimate: SaveSizeEstimate }
>()

/** The cached estimate of a chain's saved session, when it's still current. */
export const cachedEstimate = (chainId: string, sessionId: string | undefined, lastSeq: number) => {
    const known = cache.get(chainId)
    return known && known.sessionId === sessionId && known.lastSeq === lastSeq
        ? known.estimate
        : undefined
}

const BATCH = 512

const readMany = async (store: SaveStore, name: string, keys: readonly string[]) => {
    const out = new Map<string, unknown>()
    for (let at = 0; at < keys.length; at += BATCH) {
        const batch = keys.slice(at, at + BATCH)
        const values = await store.read([name], async (tx) => {
            const rows: unknown[] = []
            for (const key of batch) rows.push(await tx.get(name, hashKey(fromHex16(key))))
            return rows
        })
        batch.forEach((key, i) => out.set(key, values[i]))
    }
    return out
}

/**
 * The estimate of a Save of a chain's session (its head unless given). `bgm` is the head's BGM hash
 * when the page knows it; otherwise the media rows' `kind` hint tells it. Undefined without the chain.
 */
export const estimateSaveSize = async (
    store: SaveStore,
    chainId: string,
    { sessionId, bgm: bgmHash }: { sessionId?: string; bgm?: string } = {},
): Promise<SaveSizeEstimate | undefined> => {
    const cut = await store.read(CUT_STORES, (tx) => readCut(tx, chainId, sessionId))
    if (!cut) return
    const saved = cut.sessionId
    const lastSeq = cut.sessions.find((session) => session.id === saved)?.lastSeq ?? 0
    const known = cachedEstimate(chainId, saved, lastSeq)
    if (known) return known

    let rows
    try {
        rows = chainRows(cut, sessionId)
    } catch (error) {
        if (error instanceof ModelError) return
        throw error
    }
    const roots = new Set<string>()
    let manifest = 0
    for (const { entry } of rows) {
        manifest +=
            ESTIMATE.entryBytes +
            new TextEncoder().encode(JSON.stringify(captureEntryDescription(entry))).byteLength
        if (entry.stack)
            manifest += new TextEncoder().encode(JSON.stringify(entry.stack)).byteLength
        if (entry.kept) roots.add(toHex(entry.snapshot))
    }
    manifest += ESTIMATE.entryBytes
    const slots = cut.stack?.slots ?? []
    for (const slot of slots) {
        roots.add(toHex(slot.snapshot))
        manifest += new TextEncoder().encode(JSON.stringify(slot.step)).byteLength
    }
    const window = cut.stack?.window
    const head = window && slots[window.index - window.base]
    const last = rows.at(-1)?.entry
    const headHex = head ? toHex(head.snapshot) : last && toHex(last.snapshot)

    // Roots, then nodes level by level, then chunks: each read once, by its row.
    const rootRows = await readMany(store, 'nodes', [...roots])
    const nodes = new Set<string>()
    const chunks = new Set<string>()
    const media = new Set<string>()
    let headChunks: string[] = []
    for (const [hex, value] of rootRows) {
        const row = value as NodesRow | undefined
        if (row?.t !== 'root') continue
        manifest += row.size + ESTIMATE.recordOverhead
        const refs = unpackHashes(row.refs).map(toHex)
        const [header, ...rest] = refs
        if (header) chunks.add(header)
        for (const node of rest.slice(0, row.kinds.length)) nodes.add(node)
        if (hex === headHex) {
            headChunks = header ? [header] : []
            for (const item of rest.slice(row.kinds.length)) media.add(item)
        }
    }
    const headNodes = new Set<string>()
    if (headHex) {
        const row = rootRows.get(headHex) as NodesRow | undefined
        if (row?.t === 'root')
            for (const node of unpackHashes(row.refs).slice(1, 1 + row.kinds.length))
                headNodes.add(toHex(node))
    }
    let level = new Set<string>(nodes)
    const seen = new Set<string>()
    while (level.size) {
        const next = new Set<string>()
        for (const [hex, value] of await readMany(
            store,
            'nodes',
            [...level].filter((each) => !seen.has(each)),
        )) {
            seen.add(hex)
            const row = value as NodesRow | undefined
            if (row?.t !== 'node') continue
            manifest += row.size + ESTIMATE.recordOverhead
            for (const child of unpackHashes(row.refs).map(toHex)) {
                if (row.depth === 0) {
                    chunks.add(child)
                    if (headNodes.has(hex)) headChunks.push(child)
                } else {
                    next.add(child)
                    if (headNodes.has(hex)) headNodes.add(child)
                }
            }
        }
        level = next
    }
    let chunksBin = 0
    let headCanonical = 0
    const headSet = new Set(headChunks)
    for (const [hex, value] of await readMany(store, 'chunks', [...chunks])) {
        const row = value as { bytes?: Uint8Array; size?: number } | undefined
        if (!row?.bytes) continue
        chunksBin += row.bytes.length
        manifest += ESTIMATE.indexBytes
        if (headSet.has(hex)) headCanonical += row.size ?? row.bytes.length
    }

    let bgm: number | undefined
    let assets = 0
    for (const [hex, value] of await readMany(store, 'media', [...media])) {
        const row = value as { size?: number; kind?: string } | undefined
        if (typeof row?.size !== 'number') continue
        if (bgmHash === undefined ? row.kind === 'bgm' && bgm === undefined : hex === bgmHash)
            bgm = row.size
        else assets += row.size
    }

    const ancestors = cut.chain.revision?.ancestors.length ?? 0
    const estimate: SaveSizeEstimate = {
        steps: rows.length,
        history: Math.round(chunksBin + manifest * ESTIMATE.manifestDeflate),
        ...(bgm === undefined ? {} : { bgm }),
        base: Math.round(
            ESTIMATE.projectBytes +
                ancestors * ESTIMATE.ancestorBytes +
                headCanonical * ESTIMATE.levelRatio +
                assets,
        ),
    }
    cache.set(chainId, { sessionId: saved, lastSeq, estimate })
    return estimate
}
