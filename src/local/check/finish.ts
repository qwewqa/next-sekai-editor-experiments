import { inspectNxsp } from '../nxsp/inspect'
import type { MediaKind } from '../nxsp/read'
import { loadBodies, type SaveStore } from '../save/bodies'
import type { EntryRow } from '../save/cut'
import { markDamaged } from '../save/mark'
import { ModelError, type ModelRefusal } from '../save/model'
import { repairFromSource } from '../save/repair'
import { STORED_BATCH_ROOTS, storedMediaState, type StoredCheck } from './stored'

// Check File and History's finish, in order: repair from the file what it holds
// (each item verified against its key), check the damaged states again, mark the rows whose roots
// still reach a bad hash, then remove each media row that still fails its re-hash, one at a time
// under `nse-maint` exclusive. Check never removes a root, node or chunk. Read-only storage
// (`?safe`) writes nothing and reports the same.

/** Attempts at `nse-maint` exclusive per media row: the first and five retries, 200 ms apart. */
export const MEDIA_ATTEMPTS = 6
export const MEDIA_RETRY_MS = 200

export type MediaRemoval = {
    /**
     * Runs `body` holding `nse-maint` exclusive (`StorageCore.exclusive`, ifAvailable): `ran:
     * false` when it is held. `remove` deletes a media row inside that hold.
     */
    exclusive: <T>(
        body: (remove: (hash: string) => Promise<void>) => Promise<T>,
    ) => Promise<{ ran: true; value: T } | { ran: false }>
    sleep: (ms: number) => Promise<void>
}

/** What became of a damaged media row: whole again, removed, or left (read-only, busy, failed). */
export type MediaOutcome = 'repaired' | 'removed' | 'left'

export type CheckedMedia = { hash: string; kinds: MediaKind[]; outcome: MediaOutcome }

export type FinishResult =
    | {
          kind: 'done'
          /** Rows whose states were not whole and are now. */
          repaired: number
          /** Rows whose states are still not whole: marked now, or already marked meanwhile. */
          damaged: number
          /** Rows this check newly marked; absent when nothing was written or the marks failed. */
          marked?: number
          /** The marks could not be stored. */
          markFailed?: true
          /** Damaged media rows, each with the kinds it was used as. */
          media: CheckedMedia[]
          /** Storage was read-only: nothing was written. */
          readOnly: boolean
      }
    | { kind: 'refused'; reason: ModelRefusal }

/**
 * Removes a media row that still fails its hash, re-hashed under `nse-maint` exclusive: a row
 * stored again meanwhile (a flush, another tab's repair) is never removed.
 */
export const removeBadMedia = async (
    store: SaveStore,
    hash: string,
    removal: MediaRemoval,
): Promise<MediaOutcome> => {
    for (let attempt = 0; attempt < MEDIA_ATTEMPTS; attempt++) {
        if (attempt) await removal.sleep(MEDIA_RETRY_MS)
        try {
            const held = await removal.exclusive(async (remove) => {
                const state = await storedMediaState(store, hash)
                if (state === 'whole') return 'repaired' as const
                if (state === 'bad') await remove(hash)
                return 'removed' as const
            })
            if (held.ran) return held.value
        } catch (error) {
            console.error('A damaged media row could not be removed', hash, error)
            return 'left'
        }
    }
    return 'left'
}

const keyOf = (row: EntryRow) => `${row.sessionId}\u0000${row.seq}`

/** The rows that need any of `roots`, each once. */
const rowsOf = (check: StoredCheck, roots: Iterable<string>) => {
    const out = new Map<string, EntryRow>()
    for (const root of roots) for (const row of check.rows.get(root) ?? []) out.set(keyOf(row), row)
    return out
}

/** The finish: repair, re-check, mark, remove media. `file` is the bound file the check read. */
export const finishCheck = async (
    store: SaveStore,
    check: StoredCheck,
    { file, readOnly, removal }: { file?: Blob; readOnly: boolean; removal: MediaRemoval },
): Promise<FinishResult> => {
    const badMedia = [...check.media.values()].filter((each) => each !== undefined)

    // 1. Repair from the file, even when it is damaged elsewhere: every item is verified.
    if (!readOnly && file && (check.bad.size || badMedia.length)) {
        try {
            const source = await inspectNxsp(file, {
                token: 'check',
                role: 'target',
                fingerprint: '',
            })
            await repairFromSource(
                store,
                source,
                file,
                new Set([...check.bad, ...badMedia.map((each) => each.hash)]),
            )
        } catch (error) {
            console.error('Putting damage in storage right from the file failed', error)
        }
    }

    // 2. Check the states that were not whole again.
    const before = [...check.incomplete]
    const still = new Set<string>()
    const bad = new Set<string>()
    try {
        for (let at = 0; at < before.length; at += STORED_BATCH_ROOTS) {
            const roots = before.slice(at, at + STORED_BATCH_ROOTS)
            const bodies = await loadBodies(store, roots)
            for (const root of roots) if (!bodies.complete.has(root)) still.add(root)
            for (const hash of bodies.bad) bad.add(hash)
        }
    } catch (error) {
        if (error instanceof ModelError) return { kind: 'refused', reason: error.reason }
        throw error
    }
    const damagedBefore = rowsOf(check, before)
    const damaged = rowsOf(check, still)

    // 3. Mark what the repair left: only rows whose roots still reach a bad hash.
    let marked: number | undefined
    if (!readOnly && damaged.size)
        marked = await markDamaged(store, check.chainId, [...damaged.values()], [...bad])

    // 4. Remove media rows that still fail, one at a time under `nse-maint` exclusive.
    const media: CheckedMedia[] = []
    for (const { hash, kinds } of badMedia)
        media.push({
            hash,
            kinds,
            outcome: readOnly ? 'left' : await removeBadMedia(store, hash, removal),
        })

    return {
        kind: 'done',
        repaired: damagedBefore.size - damaged.size,
        damaged: damaged.size,
        ...(marked === undefined ? {} : { marked }),
        ...(!readOnly && damaged.size && marked === undefined ? { markFailed: true as const } : {}),
        media,
        readOnly,
    }
}
