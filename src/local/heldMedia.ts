import type { State } from '../state'
import type { BatchMedia } from './flushWrite'

// Media bytes this tab holds. The BGM's are `Bgm.source`; a
// picked cover or preview clip is kept here by hash. Applied items are kept for the tab's life,
// since both are small; a Level Info dialog releases its own unapplied picks, and only those,
// when it closes (`trackHeldPicks`). The flush and a Save's build read the held items through
// `heldItemsOf`.

const held = new Map<string, BatchMedia>()

/** Keeps a picked item's bytes for the flush and Save to carry. True when no item held that hash before. */
export const holdMedia = (item: BatchMedia) => {
    const added = !held.has(item.hash)
    held.set(item.hash, item)
    return added
}

/** Lets go of a hash's bytes. Only for a pick nothing has named: a step, a flush or a Save may need the rest. */
export const releaseHeld = (hash: string) => {
    held.delete(hash)
}

/** The item held for a hash, if this tab has it. */
export const heldItem = (hash: string) => held.get(hash)

/**
 * The media items a state names that this tab holds the bytes of: the BGM's, then the cover's and
 * the preview's, each hash once and each with its slot's kind.
 */
export const heldItemsOf = (state: State): BatchMedia[] => {
    const out: BatchMedia[] = []
    const { meta, source } = state.bgm
    if (meta && source)
        out.push({
            hash: meta.hash,
            bytes: source,
            type: meta.type,
            ...(meta.filename ? { filename: meta.filename } : {}),
            kind: 'bgm',
        })
    for (const kind of ['cover', 'preview'] as const) {
        const ref = state.levelInfo[kind]
        const item = ref && held.get(ref.hash)
        if (item && !out.some((each) => each.hash === item.hash)) out.push({ ...item, kind })
    }
    return out
}

/** Forgets everything, as a test needs between cases. */
export const resetHeldMediaForTests = () => {
    held.clear()
}
