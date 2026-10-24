import { captureName } from '../../../src/history/operations'
import { executePlan, planNxsp } from '../../../src/local/nxsp'
import type { OpenStoreRequest } from '../../../src/local/open/importWrite'
import { initialStep, nativeOperation, originOperation } from '../../helpers/historySteps'
import { fresh } from '../nxsp/chain'
import { BGM_2, chartWith, COVER_2, headInput as headInputOf, Store } from '../nxsp/helpers'
import { stateOf } from '../records/charts'

// Files the session tests open: a file of `count` rows (so an import has batches to end short of),
// and one whose first row is `kept: false` while its root stays in the file.

export const importIds = (n: number) => ({
    chainId: `chain-open-${n}`,
    sessionId: `session-open-${n}`,
    docId: `doc-open-${n}`,
    lineageId: `lineage-open-${n}`,
})

export const storeRequest = (id: string, ids: ReturnType<typeof importIds>): OpenStoreRequest => ({
    id,
    ids,
    chain: {
        name: 'Coconut (Master)',
        file: { name: 'coconut.nxsp', event: 'opened' },
    },
    operations: {
        opened: originOperation('import'),
        changedOutside: nativeOperation({ id: 'nse.externalChange', data: {} }, 'Changed outside'),
    },
    wall: 2_000_000,
    appVersion: '0.6.0',
})

/** A file with `count` rows whose every state is the head's. */
export const longFile = async (count: number) => {
    const { input } = fresh()
    const history = input.history!
    const first = history.entries[0]!
    const head = history.undoStack.slots[2]!.snapshot
    const entries = [
        { ...first, snapshot: head },
        ...Array.from({ length: count - 2 }, (_, i) => ({
            kind: 'export' as const,
            time: 2000 + i,
            operation: nativeOperation(
                {
                    id: 'nse.file.export',
                    data: { file: captureName('LevelData'), delivery: 'file' },
                },
                'Exported LevelData',
            ),
            snapshot: head,
            noteCount: 0,
        })),
        { ...history.entries.at(-1)!, snapshot: head },
    ]
    const long = {
        ...input,
        ...headInputOf(fresh().c),
        media: { bgm: input.media!.bgm, cover: input.media!.cover, preview: input.media!.preview },
        history: {
            ...history,
            entries,
            undoStack: {
                base: 0,
                slots: [
                    {
                        snapshot: head,
                        step: initialStep(history.undoStack.slots[0]!.step.operation),
                    },
                ],
                index: 0,
            },
        },
    }
    return executePlan(planNxsp(long).plan, new Map())
}

/** The shared chain with states of its own and entry 0 flagged: its root stays in the file. */
export const flaggedFile = async () => {
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
                ...(i === 0 ? { kept: false as const } : {}),
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

/** The shared chain as a file. */
export const smallFile = async () => {
    const { input } = fresh()
    return executePlan(planNxsp(input).plan, new Map())
}

/**
 * The states the files above hold, so a session opened from one can be edited by the model: its
 * stack's hashes are these states' roots.
 */
export const fileStates = () => [
    stateOf(chartWith()),
    stateOf(chartWith({ extraNotes: 1 })),
    stateOf(chartWith({ bgm: BGM_2, cover: COVER_2, extraNotes: 1 })),
    stateOf(chartWith({ extraNotes: 40 })),
]
