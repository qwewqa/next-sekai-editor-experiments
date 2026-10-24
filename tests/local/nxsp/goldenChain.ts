import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { captureName } from '../../../src/history/operations'
import { inflateStrict } from '../../../src/local/chunkVerify'
import { toHex } from '../../../src/local/hash'
import type { BuildInput, EntryForm, InputChunk, WritePlan } from '../../../src/local/nxsp'
import { noteCountOf, toRecords } from '../../../src/local/records/records'
import { chunkCrc32 } from '../../../src/local/records/rows'
import { encodeSnapshot } from '../../../src/local/records/snapshot'
import {
    editStep,
    futureFixtureOperation,
    initialStep,
    nativeOperation,
    originOperation,
} from '../../helpers/historySteps'
import { stateOf } from '../records/charts'
import {
    BGM_2,
    chartWith,
    COVER,
    COVER_2,
    entry,
    fixedContext,
    headInput,
    PREVIEW,
    Store,
} from './helpers'

// The builder golden's fixed chain, shared with the plan conformance set.

export const root = join(import.meta.dirname, 'golden-v1')
export const writing = process.env.NSE_WRITE_GOLDEN === '1'

export const T0 = Date.UTC(2026, 9, 16, 5, 0, 0)
export const DEVICE = { id: 'c3f00000-0000-4000-8000-000000000000', label: 'Web (Chrome)' }
export const REV_1 = 'r001-0000-4000-8000-000000000000'
export const REV_2 = 's001-0000-4000-8000-000000000000'

export const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
export const fromB64 = (text: string) => new Uint8Array(Buffer.from(text, 'base64'))

/** The chain's states and the store holding them; a thinned state is never stored. */
export const chain = () => {
    const store = new Store()
    const states = {
        a: stateOf(chartWith()),
        b: stateOf(chartWith({ extraNotes: 1 })),
        c: stateOf(chartWith({ bgm: BGM_2, extraNotes: 1 })),
        d: stateOf(chartWith({ bgm: BGM_2, extraNotes: 2 })),
        e: stateOf(chartWith({ bgm: BGM_2, cover: COVER_2, extraNotes: 2 })),
    }
    const hashes = Object.fromEntries(
        Object.entries(states).map(([name, state]) => [name, store.add(state)]),
    ) as Record<keyof typeof states, string>
    const counts = Object.fromEntries(
        Object.entries(states).map(([name, state]) => [name, noteCountOf(toRecords(state).kinds)]),
    ) as Record<keyof typeof states, number>
    const thinnedRecords = toRecords(stateOf(chartWith({ extraNotes: 3 })))
    const thinned = toHex(encodeSnapshot(thinnedRecords).root.hash)
    return {
        store,
        states,
        hashes,
        counts,
        thinned,
        thinnedCount: noteCountOf(thinnedRecords.kinds),
    }
}

/** The chunks' stored forms: from `store.json`, each checked against its canonical bytes. */
export const fixedChunks = (store: Store): Map<string, InputChunk> => {
    const stored = JSON.parse(readFileSync(join(root, 'store.json'), 'utf8')) as Record<
        string,
        string
    >
    const chunks = new Map<string, InputChunk>()
    for (const [hash, chunk] of store.chunks) {
        const fixed = fromB64(stored[hash] ?? '')
        assert.deepEqual(inflateStrict(fixed), inflateStrict(chunk.stored), `chunk ${hash}`)
        chunks.set(hash, { stored: fixed, crc32: chunkCrc32(Buffer.from(hash, 'hex'), fixed) })
    }
    return chunks
}

const imported = originOperation('import')
const transportStep = (id: string, description: string) =>
    editStep(futureFixtureOperation(id, {}, description))
const added = transportStep('golden-added', 'Added note')
const bgm = transportStep('golden-bgm', 'Changed BGM')
const cover = transportStep('golden-cover', 'Changed cover')

const save = (
    time: number,
    label: string,
    snapshot: string,
    noteCount: number,
    revisionId: string,
): EntryForm =>
    entry(
        {
            kind: 'save',
            operation: nativeOperation(
                {
                    id: 'nse.file.save',
                    data: { file: captureName('golden.nxsp'), delivery: 'file' },
                },
                label,
            ),
        },
        time,
        snapshot,
        { noteCount, revisionId, device: DEVICE, appVersion: '0.6.0' },
    )

export const firstInput = (
    c: ReturnType<typeof chain>,
    chunks: Map<string, InputChunk>,
): BuildInput => {
    const { store, states, hashes, counts, thinned, thinnedCount } = c
    return {
        context: fixedContext(T0, 'r'),
        id: 'd0c00000-0000-4000-8000-000000000000',
        lineageId: '11e40000-0000-4000-8000-000000000000',
        name: 'Golden (Master)',
        exportName: 'Golden',
        revision: { parent: null, n: 1, ancestors: [], fileName: 'golden.nxsp' },
        ...headInput(states.c),
        media: {
            bgm: {
                bytes: BGM_2.bytes,
                sha256: BGM_2.sha256,
                type: 'audio/mpeg',
                filename: BGM_2.ref.filename,
            },
            cover: {
                bytes: COVER.bytes,
                sha256: COVER.sha256,
                type: 'image/png',
                filename: COVER.ref.filename,
            },
            preview: {
                bytes: PREVIEW.bytes,
                sha256: PREVIEW.sha256,
                type: 'audio/mpeg',
                filename: PREVIEW.ref.filename,
            },
        },
        extra: { zzFixtureTop: 'kept', metadata: { zzFixtureMeta: [1, 2] } },
        history: {
            entries: [
                entry({ kind: 'init', operation: imported }, T0 - 5000, hashes.a, {
                    noteCount: counts.a,
                }),
                entry(
                    { kind: 'edit', step: transportStep('golden-thinned', 'Moved notes') },
                    T0 - 4000,
                    thinned,
                    {
                        noteCount: thinnedCount,
                        kept: false,
                    },
                ),
                entry({ kind: 'edit', step: added }, T0 - 3000, hashes.b, {
                    noteCount: counts.b,
                    dirty: true,
                }),
                entry({ kind: 'edit', step: bgm }, T0 - 2000, hashes.c, { noteCount: counts.c }),
                save(T0 - 1000, 'Saved golden.nxsp', hashes.c, counts.c, REV_1),
            ],
            roots: store.roots,
            nodes: store.nodes,
            chunks,
            undoStack: {
                base: 0,
                slots: [
                    { snapshot: hashes.a, step: initialStep(imported) },
                    { snapshot: hashes.b, step: added },
                    { snapshot: hashes.c, step: bgm },
                ],
                index: 2,
            },
        },
    }
}

export const secondInput = (
    c: ReturnType<typeof chain>,
    chunks: Map<string, InputChunk>,
    entries: { name: string }[],
    token = 'golden',
): BuildInput => {
    const { store, states, hashes, counts } = c
    const at = (prefix: string) => entries.findIndex((e) => e.name.startsWith(prefix))
    return {
        context: fixedContext(T0 + 3_600_000, 's'),
        id: 'd0c00000-0000-4000-8000-000000000000',
        lineageId: '11e40000-0000-4000-8000-000000000000',
        name: 'Golden (Master)',
        exportName: 'Golden',
        revision: {
            parent: REV_1,
            n: 2,
            ancestors: [REV_1],
            fileName: 'golden.nxsp',
            completeFrom: REV_1,
        },
        ...headInput(states.e),
        media: {
            bgm: {
                copy: { source: token, entryIndex: at('bgm/') },
                sha256: BGM_2.sha256,
                type: 'audio/mpeg',
                filename: BGM_2.ref.filename,
            },
            cover: {
                bytes: COVER_2.bytes,
                sha256: COVER_2.sha256,
                type: 'image/png',
                filename: COVER_2.ref.filename,
            },
            preview: {
                copy: { source: token, entryIndex: at('assets/preview.') },
                sha256: PREVIEW.sha256,
                type: 'audio/mpeg',
                filename: PREVIEW.ref.filename,
            },
        },
        extra: { zzFixtureTop: 'kept', metadata: { zzFixtureMeta: [1, 2] } },
        history: {
            append: token,
            entries: [
                entry(
                    {
                        kind: 'continue',
                        operation: nativeOperation(
                            {
                                id: 'nse.continue',
                                data: { fromTime: T0 - 1000 },
                            },
                            'Opened golden.nxsp',
                        ),
                    },
                    T0 + 1000,
                    hashes.c,
                    {
                        noteCount: counts.c,
                    },
                ),
                entry({ kind: 'edit', step: added }, T0 + 2000, hashes.d, { noteCount: counts.d }),
                entry({ kind: 'edit', step: cover }, T0 + 3000, hashes.e, { noteCount: counts.e }),
                save(T0 + 4000, 'Saved golden.nxsp', hashes.e, counts.e, REV_2),
            ],
            roots: store.roots,
            nodes: store.nodes,
            chunks,
            undoStack: {
                base: 0,
                slots: [
                    { snapshot: hashes.a, step: initialStep(imported) },
                    { snapshot: hashes.b, step: added },
                    { snapshot: hashes.c, step: bgm },
                    { snapshot: hashes.d, step: added },
                    { snapshot: hashes.e, step: cover },
                ],
                index: 4,
            },
        },
    }
}

/** A plan with deflated parts inflated, JSON parsed and binary parts in base64: what the golden compares. */
export const describePlan = (plan: WritePlan) => ({
    modified: plan.modified,
    entries: plan.entries.map((e) => ({
        name: e.name,
        method: e.method,
        crc32: e.crc32,
        uncompressedSize: e.uncompressedSize,
        parts: e.parts.map((part) => {
            if (part.kind === 'copy') return { ...part }
            const data = e.method === 8 ? new Uint8Array(inflateRawSync(part.data)) : part.data
            return e.name.endsWith('.json')
                ? { kind: 'bytes', json: JSON.parse(new TextDecoder().decode(data)) as unknown }
                : { kind: 'bytes', base64: b64(data) }
        }),
    })),
})
