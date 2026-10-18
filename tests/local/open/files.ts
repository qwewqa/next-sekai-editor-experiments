import { executePlan, planNxsp, readNxsp, type ReadHistory } from '../../../src/local/nxsp'
import { chunksOfRoot } from '../../../src/local/open/plan'
import { fresh } from '../nxsp/chain'
import { crafted } from '../nxsp/craft'
import { BGM_2, chartWith, COVER_2, Store } from '../nxsp/helpers'
import { stateOf } from '../records/charts'

// Files for the open's tests: the shared chain with a first state of its own, and that file with
// one of its chunks damaged so that only the background import finds it.

const historyOf = async (file: Blob): Promise<ReadHistory> => {
    const read = await readNxsp(file)
    if (read.kind !== 'nxsp' || !read.history) throw new Error('no history')
    return read.history
}

/** The shared chain with a first state of its own notes, so some chunks only it reaches. */
export const distinctFile = async () => {
    const { input } = fresh()
    const store = new Store()
    const states = [
        stateOf(chartWith({ extraNotes: 40 })),
        stateOf(chartWith({ extraNotes: 1 })),
        stateOf(chartWith({ bgm: BGM_2, cover: COVER_2, extraNotes: 1 })),
    ]
    const hashes = states.map((state) => store.add(state))
    const history = input.history!
    const changed = {
        ...input,
        history: {
            ...history,
            entries: history.entries.map((each, i) => ({
                ...each,
                snapshot: hashes[Math.min(i, 2)]!,
            })),
            roots: store.roots,
            nodes: store.nodes,
            chunks: store.chunks,
            undoStack: {
                ...history.undoStack,
                slots: history.undoStack.slots.map((slot, i) => ({
                    ...slot,
                    snapshot: hashes[i]!,
                })),
            },
        },
    }
    return { file: await executePlan(planNxsp(changed).plan, new Map()), hashes }
}

/** A file with one chunk only the first state reaches changed, its CRCs recomputed. */
export const damagedFile = async () => {
    const { file, hashes } = await distinctFile()
    const history = await historyOf(file)
    const later = new Set([
        ...chunksOfRoot(history, hashes[1]!),
        ...chunksOfRoot(history, hashes[2]!),
    ])
    const only = chunksOfRoot(history, hashes[0]!).filter((hash) => !later.has(hash))
    const bad = only.at(-1)!
    const place = history.index.get(bad)!
    const broken = await crafted((items) => {
        const item = items.find((each) => each.name === 'history/chunks.bin')!
        const data = new Uint8Array(item.data)
        // A byte in the middle of the deflated stream: it inflates differently, or not at all.
        const at = place.offset + Math.floor(place.length / 2)
        data[at] = (data[at] ?? 0) ^ 0x55
        item.data = data
    }, file)
    return { file: broken, bad, hashes }
}
