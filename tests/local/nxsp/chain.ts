import type { BuildInput, EntryForm } from '../../../src/local/nxsp'
import { stateOf } from '../records/charts'
import {
    BGM_2,
    chartWith,
    COVER_2,
    entry,
    fixedContext,
    headInput,
    PREVIEW,
    Store,
} from './helpers'

// A small chain the reader, builder and executor tests share.

export const NOW = Date.UTC(2026, 9, 16, 5, 41, 7, 250)

/** A chain of three states, written fresh: the second BGM and cover held, the preview as metadata. */
export const fresh = () => {
    const store = new Store()
    const a = stateOf(chartWith())
    const b = stateOf(chartWith({ extraNotes: 1 }))
    const c = stateOf(chartWith({ bgm: BGM_2, cover: COVER_2, extraNotes: 1 }))
    const [ha, hb, hc] = [store.add(a), store.add(b), store.add(c)]
    const entries: EntryForm[] = [
        entry('init', 1000, 'Imported LevelData', ha),
        entry('edit', 2000, 'Added note', hb, { dirty: true }),
        entry('edit', 3000, 'Changed BGM', hc),
        entry('save', 4000, 'Saved coconut.nxsp', hc, {
            revisionId: 'r001-0000-4000-8000-000000000000',
            device: { id: 'c3f00000-0000-4000-8000-000000000000', label: 'Web (Chrome)' },
        }),
    ]
    const input: BuildInput = {
        context: fixedContext(NOW),
        id: 'doc',
        lineageId: 'lineage',
        name: 'Coconut (Master)',
        revision: { parent: null, n: 1, ancestors: [], fileName: 'coconut.nxsp' },
        ...headInput(c),
        media: {
            bgm: {
                bytes: BGM_2.bytes,
                sha256: BGM_2.sha256,
                type: 'audio/mpeg',
                filename: BGM_2.ref.filename,
            },
            cover: {
                bytes: COVER_2.bytes,
                sha256: COVER_2.sha256,
                type: 'image/png',
                filename: 'cover-2.png',
            },
            preview: {
                hash: PREVIEW.ref.hash,
                size: PREVIEW.ref.size,
                type: 'audio/mpeg',
                filename: 'preview.mp3',
            },
        },
        extra: { zzTop: { kept: true }, metadata: { zzMeta: 1 } },
        history: {
            entries,
            roots: store.roots,
            nodes: store.nodes,
            chunks: store.chunks,
            undoStack: {
                base: 0,
                slots: [
                    { snapshot: ha, label: 'Imported LevelData' },
                    { snapshot: hb, label: 'Added note' },
                    { snapshot: hc, label: 'Changed BGM' },
                ],
                index: 2,
            },
        },
    }
    return { store, a, b, c, hashes: [ha, hb, hc], input }
}
