import { PeekError, parseEntryKey, type PeekSource } from '../history/peek'
import { loadedStates } from '../history/stack'
import type { State } from '../state'
import type { Flusher } from './flush'
import { toHex } from './hash'
import { stateFromRecords, toRecords } from './records/records'
import { decodeSnapshot, encodeSnapshot } from './records/snapshot'
import type { StorageWorker } from './worker/client'

// Where peek gets an entry's state (Part 1 §1.4.11, §1.9.2 #5): this tab's memory first (an
// entry not yet stored, or a state the undo stack still holds), else the stored snapshot, read
// and verified in the worker and built here.

/** The root each stored state was flushed as: a state the stack holds is found by its root. */
const rootOf = new WeakMap<State, string>()

export const rememberRoots = (roots: readonly (readonly [State, Uint8Array])[]) => {
    for (const [state, hash] of roots) rootOf.set(state, toHex(hash))
}

/** A state this tab holds for a root, so peeking it needs no read and shares its structure. */
const heldState = (hex: string, flusher: Flusher | undefined) => {
    for (const { state, snapshot } of loadedStates())
        if (rootOf.get(state) === hex || (snapshot && toHex(snapshot) === hex)) return state
    for (const entry of flusher?.session?.pending ?? [])
        if (entry.state && rootOf.get(entry.state) === hex) return entry.state
}

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
    a.bgm.meta?.hash === b.bgm.meta?.hash

const rootHex = (state: State) => toHex(encodeSnapshot(toRecords(state)).root.hash)

export const createPeekSource = (
    worker: StorageWorker,
    flusher: () => Flusher | undefined,
): PeekSource => {
    const build = async (hex: string, kept: boolean) => {
        const held = heldState(hex, flusher())
        if (held) return held
        const read = await worker.call('readSnapshotVerified', hex)
        if (read.kind === 'missing') throw new PeekError(kept ? 'damaged' : 'removed')
        if (read.kind === 'damaged') throw new PeekError('damaged')
        const { parts } = read
        try {
            return stateFromRecords(
                decodeSnapshot(parts.root, {
                    node: (key) => parts.nodes[key],
                    chunk: (key) => parts.chunks[key],
                }),
            )
        } catch (error) {
            console.error('A stored snapshot could not be read', error)
            throw new PeekError('damaged')
        }
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
        sameSnapshot: (a, b) => sameParts(a, b) || rootHex(a) === rootHex(b),
    }
}
