import { CHUNK_CAP, inflateStrict } from '../chunkVerify'
import { hashKey } from '../db'
import { equalBytes, fromHex16, hash16, sha256, toHex } from '../hash'
import { isObject } from '../nxsp/json'
import type { MediaKind } from '../nxsp/read'
import type { RecordValue } from '../records/canonical'
import { loadBodies, type Bodies, type SaveStore } from '../save/bodies'
import { CUT_STORES, readCut, type EntryRow } from '../save/cut'
import { checkReadable, ModelError, type ModelRefusal } from '../save/model'

// Check File and History's stored phase: the roots of every kept row of the
// chain, in all its sessions, verified as a Save's build verifies its bodies (`loadBodies`), and
// the media each whole state's header names re-hashed. A missing media row is "not loaded", not
// damage. Nothing is written here.

/** Roots per stored batch. */
export const STORED_BATCH_ROOTS = 256

/** A media item found present but failing its hash, with the kinds the headers use it as. */
export type BadMedia = { hash: string; kinds: MediaKind[] }

export type StoredCheck = {
    chainId: string
    /** Kept rows by the roots their states need (snapshot and recovered pushes). */
    rows: Map<string, EntryRow[]>
    batches: string[][]
    /** Roots not whole at the stored phase. */
    incomplete: Set<string>
    /** Bodies missing or failing their check. */
    bad: Set<string>
    /** Media checked, by hash: bad (with its kinds) or not. */
    media: Map<string, BadMedia | undefined>
    /** Header chunks whose media were read. */
    headers: Set<string>
}

export type StoredCheckOpen =
    | { kind: 'opened'; check: StoredCheck; roots: number }
    | { kind: 'noChain' }
    /** A session or row this build can't read: never judged (`needsNewer`, `unreadableHead`). */
    | { kind: 'refused'; reason: ModelRefusal }

/** A row's roots: its snapshot, then its recovered pushes. */
export const rowRoots = (entry: EntryRow) => [
    toHex(entry.snapshot),
    ...(entry.stack?.push.map((slot) => toHex(slot.snapshot)) ?? []),
]

/** Reads the chain's cut and plans its kept rows' roots in batches. */
export const openStoredCheck = async (
    store: SaveStore,
    chainId: string,
): Promise<StoredCheckOpen> => {
    const cut = await store.read(CUT_STORES, (tx) => readCut(tx, chainId))
    if (!cut) return { kind: 'noChain' }
    try {
        checkReadable(cut)
    } catch (error) {
        if (error instanceof ModelError) return { kind: 'refused', reason: error.reason }
        throw error
    }
    const rows = new Map<string, EntryRow[]>()
    for (const session of cut.sessions) {
        // An import still pending stores its rows before their states: never judged here.
        if (session.importPending) continue
        for (const entry of cut.entries.get(session.id) ?? []) {
            if (!entry.kept) continue
            for (const root of new Set(rowRoots(entry))) {
                const list = rows.get(root)
                if (list) list.push(entry)
                else rows.set(root, [entry])
            }
        }
    }
    const roots = [...rows.keys()]
    const batches: string[][] = []
    for (let at = 0; at < roots.length; at += STORED_BATCH_ROOTS)
        batches.push(roots.slice(at, at + STORED_BATCH_ROOTS))
    return {
        kind: 'opened',
        check: {
            chainId,
            rows,
            batches,
            incomplete: new Set(),
            bad: new Set(),
            media: new Map(),
            headers: new Set(),
        },
        roots: roots.length,
    }
}

/**
 * A stored media row: `missing`, `whole` (its Blob hashes to its key and its stored `sha256`), or
 * `bad` (present, but not whole).
 */
export const storedMediaState = async (
    store: SaveStore,
    hash: string,
): Promise<'missing' | 'whole' | 'bad'> => {
    const row = await store.read(['media'], (tx) => tx.get('media', hashKey(fromHex16(hash))))
    if (row === undefined) return 'missing'
    if (!isObject(row) || !(row.blob instanceof Blob)) return 'bad'
    try {
        const digest = await sha256(new Uint8Array(await row.blob.arrayBuffer()))
        const stored = row.sha256 instanceof Uint8Array ? row.sha256 : undefined
        return toHex(digest).startsWith(hash) && (!stored || equalBytes(stored, digest))
            ? 'whole'
            : 'bad'
    } catch {
        return 'bad'
    }
}

const mediaHash = (value: RecordValue | undefined) => {
    const hash = Array.isArray(value) ? (value as RecordValue[])[0] : undefined
    return typeof hash === 'string' ? hash : undefined
}

/** The media a header names, by kind: cover and preview in its level info, the BGM after it. */
const headerMediaKinds = (header: RecordValue[]): [string, MediaKind][] => {
    const levelInfo = header[7] as RecordValue[] | undefined
    const out: [string, MediaKind][] = []
    for (const [value, kind] of [
        [levelInfo?.[5], 'cover'],
        [levelInfo?.[6], 'preview'],
        [header[8], 'bgm'],
    ] as const) {
        const hash = mediaHash(value)
        if (hash) out.push([hash, kind])
    }
    return out
}

/** A whole root's header chunk, inflated and parsed; undefined when it doesn't read. */
const readHeader = async (bodies: Bodies, hex: string) => {
    const chunk = bodies.chunks.get(hex)
    if (!chunk) return
    try {
        const canonical = inflateStrict(chunk.stored, CHUNK_CAP)
        if (!equalBytes(await hash16(canonical), fromHex16(hex))) return
        const json = JSON.parse(new TextDecoder().decode(canonical)) as unknown
        return Array.isArray(json) ? (json as RecordValue[]) : undefined
    } catch {
        return
    }
}

export type StoredBatchResult =
    /** `roots` checked, for progress. */
    { kind: 'done'; roots: number } | { kind: 'refused'; reason: ModelRefusal }

/** Verifies one batch of roots, and the media of each whole one's header. */
export const checkStoredRoots = async (
    store: SaveStore,
    check: StoredCheck,
    n: number,
): Promise<StoredBatchResult> => {
    const roots = check.batches[n] ?? []
    let bodies: Bodies
    try {
        bodies = await loadBodies(store, roots)
    } catch (error) {
        if (error instanceof ModelError) return { kind: 'refused', reason: error.reason }
        throw error
    }
    for (const hash of bodies.bad) check.bad.add(hash)
    for (const root of roots) {
        if (!bodies.complete.has(root)) {
            check.incomplete.add(root)
            continue
        }
        const header = bodies.roots.get(root)?.[1]
        if (typeof header !== 'string' || check.headers.has(header)) continue
        check.headers.add(header)
        const json = await readHeader(bodies, header)
        if (!json) continue
        for (const [hash, kind] of headerMediaKinds(json)) {
            if (!check.media.has(hash))
                check.media.set(
                    hash,
                    (await storedMediaState(store, hash)) === 'bad'
                        ? { hash, kinds: [] }
                        : undefined,
                )
            const bad = check.media.get(hash)
            if (bad && !bad.kinds.includes(kind)) bad.kinds.push(kind)
        }
    }
    return { kind: 'done', roots: roots.length }
}
