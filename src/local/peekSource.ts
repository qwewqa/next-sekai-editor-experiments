import { recordError } from '../diagnostics'
import { PeekError, parseEntryKey, type PeekSource } from '../history/peek'
import { loadedStates } from '../history/stack'
import type { State } from '../state'
import type { BgmMeta } from '../state/bgm'
import type { Flusher } from './flush'
import { toHex } from './hash'
import { stateFromRecords, toRecords } from './records/records'
import { decodeSnapshot, encodeSnapshot } from './records/snapshot'
import type { StorageWorker } from './worker/client'
import type { SnapshotRead } from './worker/peekHandlers'

// Where peek gets an entry's state: this tab's memory first (an
// entry not yet stored, or a state the undo stack still holds), else the stored snapshot, read
// and verified in the worker and built here.

const sameParts = (a: State, b: State) =>
    a.store === b.store &&
    a.bpms === b.bpms &&
    a.groups === b.groups &&
    a.stages === b.stages &&
    a.groupFolders === b.groupFolders &&
    a.stageFolders === b.stageFolders &&
    a.initialLife === b.initialLife &&
    a.isDynamicStages === b.isDynamicStages &&
    a.levelInfo === b.levelInfo &&
    a.bgm.offset === b.bgm.offset &&
    sameMedia(a.bgm.meta, b.bgm.meta)

/** The BGM's whole record, as the header stores it. */
const sameMedia = (a: BgmMeta | undefined, b: BgmMeta | undefined) =>
    a === b ||
    (!!a &&
        !!b &&
        a.hash === b.hash &&
        a.filename === b.filename &&
        a.size === b.size &&
        a.type === b.type &&
        a.durationMs === b.durationMs)

/**
 * The roots states were flushed as, by their store: a selection change replaces the state but
 * keeps its chart, so the state the stack holds is found by its parts, not its identity.
 */
const rootsByStore = new WeakMap<object, { state: State; hex: string }[]>()

const remember = (state: State, hex: string) => {
    const known = rootsByStore.get(state.store) ?? []
    if (known.some((each) => each.hex === hex && sameParts(each.state, state))) return
    // A store's states rarely differ in their header; a few are kept.
    rootsByStore.set(state.store, [{ state, hex }, ...known].slice(0, 4))
}

export const rememberRoots = (roots: readonly (readonly [State, Uint8Array])[]) => {
    for (const [state, hash] of roots) remember(state, toHex(hash))
}

const rootOf = (state: State) =>
    rootsByStore.get(state.store)?.find((each) => sameParts(each.state, state))?.hex

/** A state this tab holds for a root, so peeking it needs no read and shares its structure. */
const heldState = (hex: string, flusher: Flusher | undefined) => {
    for (const { state, snapshot } of loadedStates())
        if ((snapshot && toHex(snapshot) === hex) || rootOf(state) === hex) return state
    for (const entry of flusher?.session?.pending ?? [])
        if (entry.state && rootOf(entry.state) === hex) return entry.state
}

/** A stored snapshot's state, verified: `missing` when its root is gone, `damaged` when a part is. */
export type StoredState =
    { kind: 'missing' } | { kind: 'damaged' } | { kind: 'newer' } | { kind: 'found'; state: State }

/** Reads a snapshot through the worker's verified read and builds its state. */
export const readStoredState = async (
    read: (hex: string) => Promise<SnapshotRead>,
    hex: string,
): Promise<StoredState> => {
    const result = await read(hex)
    if (result.kind !== 'found') return result
    const { parts } = result
    try {
        return {
            kind: 'found',
            state: stateFromRecords(
                decodeSnapshot(parts.root, {
                    node: (key) => parts.nodes[key],
                    chunk: (key) => parts.chunks[key],
                }),
            ),
        }
    } catch (error) {
        recordError(error)
        console.error('A stored snapshot could not be read', error)
        return { kind: 'damaged' }
    }
}

/**
 * The undo stack's loader for a restored slot: verified, since the slot becomes the
 * live head. A missing or damaged snapshot fails the load, which cancels the move.
 */
export const slotLoader =
    (read: (hex: string) => Promise<SnapshotRead>) => async (snapshot: Uint8Array) => {
        const stored = await readStoredState(read, toHex(snapshot))
        if (stored.kind !== 'found') throw new Error(`The stored undo step is ${stored.kind}`)
        return stored.state
    }

const rootHex = (state: State) => toHex(encodeSnapshot(toRecords(state)).root.hash)

export const createPeekSource = (
    worker: StorageWorker,
    flusher: () => Flusher | undefined,
): PeekSource => {
    const build = async (hex: string, kept: boolean) => {
        const held = heldState(hex, flusher())
        const read = held
            ? { kind: 'found' as const, state: held }
            : await readStoredState((hex) => worker.call('readSnapshotVerified', hex), hex)
        if (read.kind === 'missing') throw new PeekError(kept ? 'damaged' : 'removed')
        if (read.kind === 'damaged') throw new PeekError('damaged')
        if (read.kind === 'newer') throw new PeekError('newer')
        // Restore compares by root when both are known, with no hashing.
        remember(read.state, hex)
        return read.state
    }
    return {
        load: async (key) => {
            const { sessionId, seq } = parseEntryKey(key)
            const session = flusher()?.session
            if (session?.id === sessionId) {
                const entry =
                    session.pending.find((each) => each.seq === seq) ??
                    session.memoryOnly.find((each) => each.seq === seq)
                if (entry?.state) return { state: entry.state, time: entry.wall }
                if (entry?.snapshot)
                    return { state: await build(toHex(entry.snapshot), true), time: entry.wall }
            }
            const info = await worker.call('readEntry', { sessionId, seq })
            if (!info) throw new PeekError('missing')
            return { state: await build(info.snapshot, info.kept), time: info.time }
        },
        sameSnapshot: (a, b) => {
            if (sameParts(a, b)) return true
            const root = rootOf(a)
            const other = root && rootOf(b)
            // Hashing two whole charts is the fallback, for a state not stored or read.
            return other ? root === other : rootHex(a) === rootHex(b)
        },
    }
}
