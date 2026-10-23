import type { State } from '../state'
import type { BatchMedia } from './flushWrite'

// Media bytes this tab holds (Step 11 design §3.2). The BGM's are `Bgm.source` (§1.6.8.4); a
// picked cover or preview clip is kept here by hash for the tab's life, since both are small.
// The flush and a Save's build read the held items through `heldItemsOf`.

const held = new Map<string, BatchMedia>()

/** Keeps a picked item's bytes for the flush and Save to carry. */
export const holdMedia = (item: BatchMedia) => {
    held.set(item.hash, item)
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
