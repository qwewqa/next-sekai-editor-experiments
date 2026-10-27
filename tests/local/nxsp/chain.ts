import { captureName } from '../../../src/history/operations'
import type { BuildInput, EntryForm } from '../../../src/local/nxsp'
import {
    editStep,
    futureFixtureOperation,
    initialStep,
    nativeOperation,
    noteAdd,
    originOperation,
} from '../../helpers/historySteps'
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
export const fresh = (bgm: typeof BGM_2 = BGM_2) => {
    const store = new Store()
    const a = stateOf(chartWith())
    const b = stateOf(chartWith({ extraNotes: 1 }))
    const c = stateOf(chartWith({ bgm, cover: COVER_2, extraNotes: 1 }))
    const [ha, hb, hc] = [store.add(a), store.add(b), store.add(c)]
    const imported = originOperation('import')
    const added = editStep(noteAdd(1))
    const media = editStep(futureFixtureOperation('combined-media', {}, 'Changed BGM and cover'))
    const entries: EntryForm[] = [
        entry({ kind: 'init', operation: imported }, 1000, ha),
        entry({ kind: 'edit', step: added }, 2000, hb, { dirty: true }),
        entry({ kind: 'edit', step: media }, 3000, hc),
        entry(
            {
                kind: 'save',
                operation: nativeOperation(
                    {
                        id: 'nse.file.save',
                        data: { file: captureName('coconut.nxsp'), delivery: 'file' },
                    },
                    'Saved coconut.nxsp',
                ),
            },
            4000,
            hc,
            {
                revisionId: 'r001-0000-4000-8000-000000000000',
                device: { id: 'c3f00000-0000-4000-8000-000000000000', label: 'Web (Chrome)' },
                appVersion: '0.6.0',
            },
        ),
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
                bytes: bgm.bytes,
                sha256: bgm.sha256,
                type: 'audio/mpeg',
                filename: bgm.ref.filename,
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
                    { snapshot: ha, step: initialStep(imported) },
                    { snapshot: hb, step: added },
                    { snapshot: hc, step: media },
                ],
                index: 2,
            },
        },
    }
    return { store, a, b, c, hashes: [ha, hb, hc], input }
}
