import { NO_USE_DAY } from './days'
import { bumpEpoch, FORMAT_VERSION, hashKey, readMeta } from './db'
import { GC_GRACE_DAYS } from './gc'
import { toHex } from './hash'
import type { KvTx } from './kv/types'
import { headOf } from './open/earlier'
import { isKnownNodeType, isNewerRootVersion, isNewerSessionVersion } from './records/unknownValues'
import type { StorageCore } from './worker/core'

// Cleanup under pressure (deletion design §3.7, DEL-D1 final): the one automatic removal of stored
// data, and it removes only cached earlier media, the media rows no chain's latest state uses. It
// never removes Timeline history. An earlier step whose BGM went says "BGM not loaded" and offers
// Choose Audio…; the open tab's own audio and the flush's re-store of held media cover the rest.

export type CleanupResult =
    | { kind: 'removed'; bytes: number; items: number }
    /** `nse-maint` is held or wanted, or an import is running: retry later. */
    | { kind: 'busy' }
    /** Data a newer build wrote: nothing removed. */
    | { kind: 'unsafe'; why: string }

/** The stores the removing transaction reads and writes. */
export const CLEANUP_STORES = [
    'chains',
    'sessions',
    'entries',
    'stackBlocks',
    'nodes',
    'media',
    'meta',
]

type Row = Record<string, unknown>

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null

const packed = (value: unknown): Uint8Array[] => {
    if (!(value instanceof Uint8Array) || value.byteLength % 16) return []
    const out: Uint8Array[] = []
    for (let at = 0; at < value.byteLength; at += 16) out.push(value.subarray(at, at + 16))
    return out
}

class Unsafe extends Error {}

/** A session's last entry's snapshot: where it landed when its stack was removed (§2.5). */
const lastSnapshot = async (tx: KvTx, session: Row) => {
    if (typeof session.lastSeq !== 'number') return
    const entry = await tx.get('entries', [session.id as string, session.lastSeq])
    return isRow(entry) ? entry.snapshot : undefined
}

/** What every chain's latest state reaches directly (its root's `refs`, media among them). */
const usedByHeads = async (tx: KvTx) => {
    const used = new Set<string>()
    for (const chain of await tx.getAll('chains')) {
        // Marked chains too: Undo brings a Delete back.
        if (!isRow(chain) || typeof chain.head !== 'string') continue
        const session = await tx.get('sessions', chain.head)
        if (!isRow(session)) continue
        const root = (await headOf(tx, session)) ?? (await lastSnapshot(tx, session))
        if (!(root instanceof Uint8Array) || root.byteLength !== 16) continue
        const node = await tx.get('nodes', hashKey(root))
        if (!isRow(node)) continue
        if (!isKnownNodeType(node.t)) throw new Unsafe('a head of an unknown type')
        if (node.t === 'root' && isNewerRootVersion(node.v))
            throw new Unsafe('a head root of a newer version')
        for (const hash of packed(node.refs)) used.add(toHex(hash))
    }
    return used
}

/**
 * The removing transaction: the media rows no chain's latest state uses, first stored at least
 * the grace period of days of use ago, largest first, until `bytes` are freed. The class is read
 * here, in the transaction that removes, so a flush that made one current just before keeps it.
 */
export const removeCachedMediaTx = async (tx: KvTx, bytes: number): Promise<CleanupResult> => {
    if (((await readMeta(tx, 'formatVersion')) ?? FORMAT_VERSION) > FORMAT_VERSION)
        return { kind: 'unsafe', why: 'a newer database format' }
    const days = (await readMeta(tx, 'daysOfUse')) ?? NO_USE_DAY
    if ((await tx.getAll('sessions')).some((row) => isRow(row) && isNewerSessionVersion(row.v)))
        return { kind: 'unsafe', why: 'a session of a newer version' }
    let used: Set<string>
    try {
        used = await usedByHeads(tx)
    } catch (error) {
        if (error instanceof Unsafe) return { kind: 'unsafe', why: error.message }
        throw error
    }
    const cached: { key: ArrayBuffer; size: number }[] = []
    for (const { primaryKey, value } of await tx.entries('media')) {
        const key = primaryKey as ArrayBuffer
        if (!isRow(value) || used.has(toHex(new Uint8Array(key)))) continue
        // A row with no day, or one first stored within the grace period, stays (GC's rule).
        if (typeof value.day !== 'number' || days - value.day < GC_GRACE_DAYS) continue
        const size = typeof value.size === 'number' ? value.size : 0
        cached.push({ key, size })
    }
    cached.sort((a, b) => b.size - a.size)
    let freed = 0
    let items = 0
    for (const { key, size } of cached) {
        if (freed >= bytes) break
        await tx.delete('media', key)
        freed += size
        items++
    }
    if (items) await bumpEpoch(tx)
    return { kind: 'removed', bytes: freed, items }
}

/**
 * Removes cached earlier media in one transaction under `nse-maint` exclusive (R1). Busy while an
 * import runs: its later batches may rely on media its earlier ones found stored.
 */
export const removeCachedMedia = async (
    core: StorageCore,
    { bytes }: { bytes: number },
): Promise<CleanupResult> => {
    const ran = await core.exclusive(async (hold): Promise<CleanupResult> => {
        if (await hold.importRunning()) return { kind: 'busy' }
        return hold.write(CLEANUP_STORES, (tx) => removeCachedMediaTx(tx, bytes))
    })
    if (!ran.ran) return { kind: 'busy' }
    if (ran.value.kind === 'removed' && ran.value.items) core.spaceFreed()
    return ran.value
}
