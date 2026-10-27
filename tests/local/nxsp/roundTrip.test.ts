import assert from 'node:assert/strict'
import test from 'node:test'
import { captureName } from '../../../src/history/operations'
import {
    executePlan,
    inspectNxsp,
    levelInfoOf,
    planNxsp,
    readNxsp,
    type BuildInput,
} from '../../../src/local/nxsp'
import { canonical } from '../../../src/local/records/canonical'
import { toRecords } from '../../../src/local/records/records'
import { editStep, nativeOperation, noteAdd } from '../../helpers/historySteps'
import { stateOf } from '../records/charts'
import { fresh, NOW } from './chain'
import {
    BGM,
    BGM_2,
    blobBytes,
    chartWith,
    COVER,
    COVER_2,
    entry,
    fixedContext,
    headInput,
    memorySource,
    PREVIEW,
} from './helpers'

test('a fresh write opens fully, with its history, media and unknown keys', async () => {
    const { c, hashes, input } = fresh()
    const { plan, project, revisionId } = planNxsp(input)
    const file = await executePlan(plan, new Map())
    const read = await readNxsp(file)
    assert.equal(read.kind, 'nxsp')
    if (read.kind !== 'nxsp') return
    assert.deepEqual(read.report, [])
    assert.equal(read.open, 'full')
    assert.deepEqual(read.projectJson, project)

    const p = read.project
    assert.ok(p)
    assert.equal(p.revision?.id, revisionId)
    assert.equal(p.revision?.savedAt, '2026-10-16T05:41:07Z')
    assert.equal(p.revision?.completeFrom, revisionId)
    assert.equal(p.minor, 0)
    assert.deepEqual(read.extra, { zzTop: { kept: true }, metadata: { zzMeta: 1 } })
    assert.deepEqual(p.bgm, {
        file: 'bgm/Coconut-Master.mp3',
        filename: 'Coconut (Master).mp3',
        type: 'audio/mpeg',
        sha256: BGM_2.sha256,
        size: BGM_2.bytes.length,
    })
    assert.equal(p.metadata?.cover?.file, 'assets/cover.png')
    assert.deepEqual(p.metadata?.preview, {
        filename: 'preview.mp3',
        type: 'audio/mpeg',
        hash: PREVIEW.ref.hash,
        size: PREVIEW.ref.size,
    })
    assert.deepEqual(levelInfoOf(p.metadata), c.levelInfo)
    assert.deepEqual(Object.keys(read.media).sort(), ['bgm', 'cover'])

    const history = read.history
    assert.ok(history)
    assert.equal(history.entries.length, 4)
    assert.equal(history.head, hashes[2])
    assert.equal(
        canonical([
            history.headRecords.header,
            history.headRecords.kinds.map((k) => k.records.map((r) => r.record)),
        ]),
        canonical([
            toRecords(c).header,
            toRecords(c).kinds.map((k) => k.records.map((r) => r.record)),
        ]),
    )
    assert.deepEqual(new Set(history.roots.keys()), new Set(hashes))
})

test('the BGM entry name is ASCII, from the original name', async () => {
    const { input } = fresh()
    input.media.bgm = {
        bytes: BGM.bytes,
        sha256: BGM.sha256,
        type: 'audio/mpeg',
        filename: BGM.ref.filename,
    }
    const { plan } = planNxsp(input)
    assert.ok(plan.entries.some((e) => e.name === 'bgm/bgm.mp3'))
})

test("a write-back appends: the source's chunks.bin is the prefix, its rows carried", async () => {
    const first = fresh()
    const { plan } = planNxsp(first.input)
    const file1 = await executePlan(plan, new Map())
    const source = await inspectNxsp(file1, { token: 't', role: 'target', fingerprint: 'zip:test' })

    const store = first.store
    const d = stateOf(chartWith({ bgm: BGM_2, cover: COVER_2, extraNotes: 2 }))
    const hd = store.add(d)
    const added = editStep(noteAdd(1))
    const input2: BuildInput = {
        ...first.input,
        context: fixedContext(NOW + 60_000, 's'),
        revision: {
            parent: 'r001-0000-4000-8000-000000000000',
            n: 2,
            ancestors: ['r001-0000-4000-8000-000000000000'],
        },
        ...headInput(d),
        media: {
            bgm: {
                copy: {
                    source: 't',
                    entryIndex: source.entries.findIndex((e) => e.name.startsWith('bgm/')),
                },
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
            preview: first.input.media.preview,
        },
        history: {
            append: 't',
            entries: [
                entry(
                    {
                        kind: 'continue',
                        operation: nativeOperation(
                            { id: 'nse.continue', data: { fromTime: 1000 } },
                            'Continued',
                        ),
                    },
                    5000,
                    first.hashes[2] ?? '',
                ),
                entry({ kind: 'edit', step: added }, 6000, hd),
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
                    7000,
                    hd,
                    {
                        revisionId: 's001-0000-4000-8000-000000000000',
                        device: {
                            id: 'c3f00000-0000-4000-8000-000000000000',
                            label: 'Web (Chrome)',
                        },
                    },
                ),
            ],
            roots: store.roots,
            nodes: store.nodes,
            chunks: store.chunks,
            undoStack: {
                base: 0,
                slots: [...first.input.history!.undoStack.slots, { snapshot: hd, step: added }],
                index: 3,
            },
        },
        completeFrom: undefined,
    } as BuildInput
    input2.revision.completeFrom = 'r001-0000-4000-8000-000000000000'
    const result = planNxsp(input2, [source])
    const file2 = await executePlan(result.plan, new Map([['t', memorySource(file1)]]))
    const read = await readNxsp(file2)
    assert.equal(read.kind, 'nxsp')
    if (read.kind !== 'nxsp') return
    assert.deepEqual(read.report, [])
    assert.equal(read.history?.entries.length, 7)
    assert.equal(read.project?.revision?.completeFrom, 'r001-0000-4000-8000-000000000000')

    // The old chunks.bin is a byte prefix of the new one.
    const read1 = await readNxsp(file1)
    assert.ok(read1.kind === 'nxsp' && read1.history)
    const bytes1 = await blobBytes(file1)
    const bytes2 = await blobBytes(file2)
    const chunks = (bytes: Uint8Array, offset: number, length: number) =>
        bytes.subarray(offset, offset + length)
    const entryData = async (blob: Blob, name: string) => {
        const s = await inspectNxsp(blob, { token: 'x', role: 'target', fingerprint: '' })
        const e = s.entries.find((x) => x.name === name)
        assert.ok(e)
        return { offset: e.dataOffset, length: e.compressedSize }
    }
    const old = await entryData(file1, 'history/chunks.bin')
    const now = await entryData(file2, 'history/chunks.bin')
    assert.deepEqual(chunks(bytes2, now.offset, old.length), chunks(bytes1, old.offset, old.length))
    void COVER
})
