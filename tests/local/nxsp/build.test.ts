import assert from 'node:assert/strict'
import test from 'node:test'
import { inflateRawSync } from 'node:zlib'
import {
    executePlan,
    inspectNxsp,
    PlanError,
    planNxsp,
    readNxsp,
    type BuildInput,
    type EntryForm,
    type PinnedSource,
    type WritePlan,
} from '../../../src/local/nxsp'
import { carriersIn } from '../../../src/local/nxsp/manifest'
import { minorOf, patchOf } from '../../../src/local/nxsp/version'
import { editStep, futureFixtureOperation, initialStep } from '../../helpers/historySteps'
import { stateOf } from '../records/charts'
import { fresh, NOW } from './chain'
import { crafted, jsonOf, setJson, unzip, type Loose } from './craft'
import {
    BGM_2,
    chartWith,
    COVER_2,
    entry,
    fixedContext,
    headInput,
    memorySource,
    PREVIEW,
    Store,
} from './helpers'

const DEVICE = { id: 'c3f00000-0000-4000-8000-000000000000', label: 'Web (Chrome)' }

const jsonPart = (plan: WritePlan, name: string) => {
    const planned = plan.entries.find((e) => e.name === name)
    assert.ok(planned, name)
    const [part] = planned.parts
    assert.ok(part?.kind === 'bytes')
    return JSON.parse(new TextDecoder().decode(inflateRawSync(part.data))) as Loose
}

/** A chain of `count` entries over a few states, the last a save; `late` first appears at `lateAt`. */
const longChain = (count: number, lateAt?: number) => {
    const store = new Store()
    const states = [0, 1, 2].map((n) => stateOf(chartWith({ extraNotes: n })))
    const hashes = states.map((state) => store.add(state))
    const late = store.add(stateOf(chartWith({ bgm: BGM_2, cover: COVER_2, extraNotes: 5 })))
    const entries: EntryForm[] = []
    for (let i = 0; i < count - 1; i++) {
        const snapshot = i === lateAt ? late : (hashes[i % 3] as string)
        entries.push(
            entry(
                i
                    ? {
                          kind: 'edit',
                          step: editStep(
                              futureFixtureOperation('segmented-row', { index: i }, `Step ${i}`),
                          ),
                      }
                    : {
                          kind: 'init',
                          operation: futureFixtureOperation(
                              'segmented-origin',
                              { index: i },
                              `Step ${i}`,
                          ),
                      },
                1000 + i,
                snapshot,
            ),
        )
    }
    const head = hashes[(count - 2) % 3] as string
    entries.push(
        entry(
            { kind: 'save', operation: futureFixtureOperation('segmented-save', {}, 'Saved') },
            1000 + count,
            head,
            {
                revisionId: 'r001-0000-4000-8000-000000000000',
                device: DEVICE,
            },
        ),
    )
    const { input } = fresh()
    const { bgm, levelInfo } = chartWith().extras
    // The head's BGM and cover as metadata only: the first ones.
    const built: BuildInput = {
        ...input,
        ...headInput(states[(count - 2) % 3] as (typeof states)[number]),
        media: {
            bgm: { hash: bgm?.hash ?? '', size: 1, type: 'audio/mpeg', filename: '' },
            cover: { hash: levelInfo?.cover?.hash ?? '', size: 1, type: 'image/png', filename: '' },
            ...(input.media.preview ? { preview: input.media.preview } : {}),
        },
        history: {
            entries,
            roots: store.roots,
            nodes: store.nodes,
            chunks: store.chunks,
            undoStack: {
                base: 0,
                slots: [
                    { snapshot: head, step: initialStep(futureFixtureOperation('segmented-head')) },
                ],
                index: 0,
            },
        },
    }
    return { store, hashes, late, input: built }
}

test('without an append source, the chronology goes in segments of 500, then the manifest', async () => {
    const { input, late } = longChain(1001, 750)
    const { plan } = planNxsp(input)
    const names = plan.entries.map((e) => e.name)
    assert.deepEqual(names.slice(0, 5), [
        'project.json',
        'level.json',
        'history/segments/1.json',
        'history/segments/2.json',
        'history/manifest.json',
    ])
    const s1 = jsonPart(plan, 'history/segments/1.json')
    const s2 = jsonPart(plan, 'history/segments/2.json')
    const manifest = jsonPart(plan, 'history/manifest.json')
    assert.deepEqual(Object.keys(s1), ['entries', 'roots', 'nodes', 'chunks'])
    assert.equal(s1.entries.length, 500)
    assert.equal(s2.entries.length, 500)
    assert.equal(manifest.entries.length, 1)
    assert.equal(manifest.entries[0].kind, 'save')
    assert.equal(Object.keys(s1.roots).length, 3)
    assert.deepEqual(Object.keys(s2.roots), [late])
    assert.deepEqual(Object.keys(manifest.roots), [])
    // Each part's index covers a contiguous range after the previous one.
    const last = s1.chunks.at(-1) as [string, number, number]
    assert.equal(s2.chunks[0][1], last[1] + last[2])
    const project = jsonPart(plan, 'project.json')
    assert.deepEqual(project.history, {
        manifest: 'history/manifest.json',
        chunks: 'history/chunks.bin',
        entries: 1001,
        segments: ['history/segments/1.json', 'history/segments/2.json'],
    })
    const read = await readNxsp(await executePlan(plan, new Map()))
    assert.ok(read.kind === 'nxsp')
    assert.deepEqual(read.report, [])
    assert.equal(read.history?.entries.length, 1001)
})

test('the partition boundaries: 500 entries make no segment, 501 make one', () => {
    for (const [count, segments, inManifest] of [
        [500, 0, 500],
        [501, 1, 1],
        [1000, 1, 500],
    ] as const) {
        const { plan } = planNxsp(longChain(count).input)
        assert.equal(
            plan.entries.filter((e) => e.name.startsWith('history/segments/')).length,
            segments,
            `${count}`,
        )
        assert.equal(jsonPart(plan, 'history/manifest.json').entries.length, inManifest)
    }
})

test('a key with two values in two parts is unreadable history', async () => {
    const { plan } = planNxsp(longChain(1001, 750).input)
    const file = await executePlan(plan, new Map())
    const { crafted, jsonOf, setJson } = await import('./craft')
    const bad = await crafted((items) => {
        const s1 = jsonOf(items, 'history/segments/1.json')
        const s2 = jsonOf(items, 'history/segments/2.json')
        const [key, value] = Object.entries(s1.roots)[0] as [string, unknown[]]
        s2.roots[key] = [...value.slice(0, 3), 99]
        setJson(items, 'history/segments/2.json', s2)
    }, file)
    const read = await readNxsp(bad)
    assert.ok(read.kind === 'nxsp')
    assert.ok(
        read.report.some(({ detail }) => detail === 'two values'),
        JSON.stringify(read.report),
    )
    assert.equal(read.history, undefined)
})

const appendInput = (
    input: BuildInput,
    source: PinnedSource,
    entries: EntryForm[],
    head: string,
): BuildInput => {
    const history = input.history
    assert.ok(history)
    return {
        ...input,
        context: fixedContext(NOW + 60_000, 's'),
        revision: {
            parent: 'r001-0000-4000-8000-000000000000',
            n: 2,
            ancestors: ['r001-0000-4000-8000-000000000000'],
            completeFrom: 'r001-0000-4000-8000-000000000000',
        },
        history: {
            ...history,
            append: source.token,
            entries,
            undoStack: {
                base: 0,
                slots: [
                    { snapshot: head, step: initialStep(futureFixtureOperation('append-head')) },
                ],
                index: 0,
            },
        },
    }
}

test('an append: a source manifest of 500 or more becomes a segment; fewer are carried into the manifest', async () => {
    const chain = longChain(500)
    const first = await executePlan(planNxsp(chain.input).plan, new Map())
    const source = await inspectNxsp(first, { token: 't', role: 'target', fingerprint: 'f' })
    const head = chain.hashes[0] as string
    const rows = [
        entry(
            {
                kind: 'continue',
                operation: futureFixtureOperation('append-continue', {}, 'Continued'),
            },
            9000,
            head,
        ),
        entry(
            { kind: 'save', operation: futureFixtureOperation('segmented-save', {}, 'Saved') },
            9001,
            head,
            {
                revisionId: 's001-0000-4000-8000-000000000000',
                device: DEVICE,
            },
        ),
    ]
    const second = planNxsp(appendInput(chain.input, source, rows, head), [source])
    const names = second.plan.entries.map((e) => e.name)
    assert.ok(names.includes('history/segments/1.json'))
    const segment = jsonPart(second.plan, 'history/segments/1.json')
    const sourceManifest = source.manifest?.manifest as Record<string, unknown>
    assert.deepEqual(segment, {
        entries: sourceManifest.entries,
        roots: sourceManifest.roots,
        nodes: sourceManifest.nodes,
        chunks: sourceManifest.chunks,
    })
    assert.equal(jsonPart(second.plan, 'history/manifest.json').entries.length, 2)
    const chunks = second.plan.entries.find((e) => e.name === 'history/chunks.bin')
    assert.deepEqual(
        chunks?.parts.map((p) => p.kind),
        ['copy'],
    )
    const file2 = await executePlan(second.plan, new Map([['t', memorySource(first, 'f')]]))
    const read2 = await readNxsp(file2)
    assert.ok(read2.kind === 'nxsp')
    assert.deepEqual(read2.report, [])
    assert.equal(read2.project?.history?.entries, 502)

    // The next append copies that segment whole and carries the small manifest.
    const source2 = await inspectNxsp(file2, { token: 'u', role: 'target', fingerprint: 'g' })
    const rows3 = [
        entry(
            { kind: 'save', operation: futureFixtureOperation('segmented-save', {}, 'Saved') },
            9100,
            head,
            {
                revisionId: 's001-0000-4000-8000-000000000000',
                device: DEVICE,
            },
        ),
    ]
    const third = planNxsp(appendInput(chain.input, source2, rows3, head), [source2])
    const segmentEntry = third.plan.entries.find((e) => e.name === 'history/segments/1.json')
    assert.equal(segmentEntry?.parts[0]?.kind, 'copy')
    assert.equal(jsonPart(third.plan, 'history/manifest.json').entries.length, 3)
    const read3 = await readNxsp(
        await executePlan(third.plan, new Map([['u', memorySource(file2, 'g')]])),
    )
    assert.ok(read3.kind === 'nxsp')
    assert.deepEqual(read3.report, [])
    assert.equal(read3.history?.entries.length, 503)
})

test('completeFrom: own id by default, placed when an ancestor, clamped to the last ancestor otherwise', () => {
    const { input } = fresh()
    const ids = (completeFrom: string | undefined, ancestors: string[]) =>
        planNxsp({
            ...input,
            context: fixedContext(NOW),
            revision: {
                parent: ancestors[0] ?? null,
                n: 1,
                ancestors,
                ...(completeFrom ? { completeFrom } : {}),
            },
        }).project.revision as Record<string, unknown>
    assert.equal(ids(undefined, []).completeFrom, 'r001-0000-4000-8000-000000000000')
    assert.equal(ids('b', ['a', 'b', 'c']).completeFrom, 'b')
    assert.equal(ids('z', ['a', 'b', 'c']).completeFrom, 'c')
    assert.equal(ids('z', []).completeFrom, 'r001-0000-4000-8000-000000000000')
    const withoutHistory: BuildInput = { ...input, context: fixedContext(NOW) }
    delete withoutHistory.history
    const none = planNxsp(withoutHistory).project
    assert.equal((none.revision as Record<string, unknown>).completeFrom, undefined)
    assert.equal(none.history, undefined)
    assert.throws(
        () =>
            planNxsp({
                ...input,
                context: fixedContext(NOW),
                revision: { ...input.revision, ancestors: Array.from({ length: 1025 }, String) },
            }),
        PlanError,
    )
})

test('the builder fails, never filters: a row without its root, a head media mismatch, no save entry', () => {
    const base = fresh()
    const history = base.input.history
    assert.ok(history)
    const missing = new Map(history.roots)
    missing.delete(base.hashes[1] as string)
    assert.throws(
        () =>
            planNxsp({
                ...base.input,
                context: fixedContext(NOW),
                history: { ...history, roots: missing },
            }),
        PlanError,
    )
    assert.throws(
        () =>
            planNxsp({
                ...base.input,
                context: fixedContext(NOW),
                media: {
                    ...base.input.media,
                    cover: { hash: '0'.repeat(32), size: 1, type: '', filename: '' },
                },
            }),
        PlanError,
    )
    assert.throws(
        () =>
            planNxsp({
                ...base.input,
                context: fixedContext(NOW),
                media: { bgm: base.input.media.bgm },
            }),
        PlanError,
    )
    assert.throws(
        () =>
            planNxsp({
                ...base.input,
                context: fixedContext(NOW),
                history: { ...history, entries: history.entries.slice(0, -1) },
            }),
        PlanError,
    )
    assert.throws(
        () =>
            planNxsp({
                ...base.input,
                context: fixedContext(NOW),
                history: { ...history, undoStack: { ...history.undoStack, index: 3 } },
            }),
        PlanError,
    )
    // A written BGM that isn't the head's, when the head's is given.
    const headBgm = BGM_2.sha256.slice(0, 32)
    assert.ok(planNxsp({ ...base.input, headBgm }).plan)
    assert.ok(
        planNxsp({ ...base.input, headBgm: null, media: { ...base.input.media, bgm: undefined } })
            .plan,
    )
    for (const other of ['0'.repeat(32), null])
        assert.throws(() => planNxsp({ ...base.input, headBgm: other }), PlanError)
})

test('a kept: false row keeps its root only when every node and chunk it reaches is there', () => {
    const base = fresh()
    const history = base.input.history
    assert.ok(history)
    const extra = new Store()
    const thinned = extra.add(stateOf(chartWith({ extraNotes: 7 })))
    const roots = new Map([...history.roots, [thinned, extra.roots.get(thinned) ?? []]])
    const entries = [...history.entries]
    entries.splice(
        1,
        0,
        entry(
            { kind: 'edit', step: editStep(futureFixtureOperation('thinned-row', {}, 'Thinned')) },
            1500,
            thinned,
            { kept: false },
        ),
    )
    const without = planNxsp({
        ...base.input,
        context: fixedContext(NOW),
        history: { ...history, roots, entries },
    })
    assert.equal(
        Object.hasOwn(jsonPart(without.plan, 'history/manifest.json').roots, thinned),
        false,
    )
    const complete = planNxsp({
        ...base.input,
        context: fixedContext(NOW),
        history: {
            ...history,
            entries,
            roots,
            nodes: new Map([...history.nodes, ...extra.nodes]),
            chunks: new Map([...history.chunks, ...extra.chunks]),
        },
    })
    assert.equal(
        Object.hasOwn(jsonPart(complete.plan, 'history/manifest.json').roots, thinned),
        true,
    )
})

test('chunks in first-reference order: the chronology, then the stack, then other roots by hash', () => {
    const base = fresh()
    const history = base.input.history
    assert.ok(history)
    const extra = new Store()
    const others = [7, 8, 9].map((n) => extra.add(stateOf(chartWith({ extraNotes: n }))))
    const { plan } = planNxsp({
        ...base.input,
        context: fixedContext(NOW),
        history: {
            ...history,
            roots: new Map([...history.roots, ...extra.roots]),
            nodes: new Map([...history.nodes, ...extra.nodes]),
            chunks: new Map([...history.chunks, ...extra.chunks]),
            otherRoots: [...others].reverse(),
        },
    })
    const manifest = jsonPart(plan, 'history/manifest.json')
    assert.deepEqual(Object.keys(manifest.roots), [...base.hashes, ...[...others].sort()])
    // Every chunk once, contiguous from 0.
    let at = 0
    for (const [, offset, length] of manifest.chunks as [string, number, number][]) {
        assert.equal(offset, at)
        at += length
    }
    // The first chunk is the first root's header.
    assert.equal(manifest.chunks[0][0], manifest.roots[base.hashes[0] as string][1])
})

test('the builder refuses a file that would need ZIP64, from its planned sizes', () => {
    const { input } = fresh()
    const huge: PinnedSource = {
        token: 'h',
        role: 'target',
        fingerprint: 'f',
        size: 0,
        projectJson: {},
        entries: [
            {
                index: 0,
                name: 'bgm/x.mp3',
                method: 0,
                crc32: 0,
                compressedSize: 0xffffffff,
                uncompressedSize: 0xffffffff,
                dataOffset: 40,
            },
        ],
    }
    assert.throws(
        () =>
            planNxsp(
                {
                    ...input,
                    context: fixedContext(NOW),
                    media: {
                        ...input.media,
                        bgm: {
                            copy: { source: 'h', entryIndex: 0 },
                            sha256: BGM_2.sha256,
                            type: 'audio/mpeg',
                            filename: 'x.mp3',
                        },
                    },
                },
                [huge],
                // Past the media cap too; a larger one leaves only the ZIP64 refusal.
                { media: 2 ** 33 },
            ),
        (error: unknown) => error instanceof PlanError && error.limit === 'zip64',
    )
})

test('the builder refuses every reader cap as a PlanError naming it', () => {
    const { input } = fresh()
    const refuses = (limit: string, run: () => unknown) =>
        assert.throws(
            run,
            (error: unknown) => error instanceof PlanError && error.limit === limit,
            limit,
        )
    const MB = 1024 * 1024
    // The real caps, where a test can reach them cheaply.
    refuses('project', () => planNxsp({ ...input, extra: { pad: 'a'.repeat(MB) } }))
    let deep: unknown = 1
    for (let i = 0; i < 64; i++) deep = [deep]
    refuses('depth', () => planNxsp({ ...input, extra: { deep } }))
    const sourceWith = (name: string, size: number): PinnedSource => ({
        token: 'h',
        role: 'target',
        fingerprint: 'f',
        size: 0,
        projectJson: {},
        entries: [
            {
                index: 0,
                name,
                method: 0,
                crc32: 0,
                compressedSize: size,
                uncompressedSize: size,
                dataOffset: 40,
            },
        ],
    })
    const bgm = (size: number) =>
        planNxsp(
            {
                ...input,
                media: {
                    ...input.media,
                    bgm: {
                        copy: { source: 'h', entryIndex: 0 },
                        sha256: BGM_2.sha256,
                        type: 'audio/mpeg',
                        filename: 'x.mp3',
                    },
                },
            },
            [sourceWith('bgm/x.mp3', size)],
        )
    refuses('bgm', () => bgm(1024 * MB + 1))
    assert.ok(bgm(1024 * MB).plan)
    // The rest with smaller caps: the same checks, by planned size.
    refuses('level', () => planNxsp(input, [], { level: 100 }))
    refuses('part', () => planNxsp(input, [], { manifest: 100 }))
    refuses('chunks', () => planNxsp(input, [], { chunksBin: 100 }))
    refuses('cover', () => planNxsp(input, [], { media: 5 }))
    refuses('segments', () => planNxsp(longChain(1001).input, [], { segments: 1 }))
    // The parts together: just over their sum is refused, their sum passes.
    const long = longChain(1001).input
    const sum = planNxsp(long)
        .plan.entries.filter((e) => e.name.startsWith('history/') && e.name.endsWith('.json'))
        .reduce((total, e) => total + (e.uncompressedSize ?? 0), 0)
    refuses('history', () => planNxsp(long, [], { history: sum - 1 }))
    assert.ok(planNxsp(long, [], { history: sum }).plan)
    assert.ok(planNxsp(longChain(1001).input, [], { segments: 2 }).plan)
    const preview = {
        ...input,
        levelInfo: { ...input.levelInfo, preview: { ...PREVIEW.ref } },
        media: {
            ...input.media,
            preview: {
                bytes: PREVIEW.bytes,
                sha256: PREVIEW.sha256,
                type: 'audio/mpeg',
                filename: 'preview.mp3',
            },
        },
    }
    refuses('preview', () => planNxsp(preview, [], { media: PREVIEW.bytes.length - 1 }))
    assert.ok(planNxsp(preview, [], { media: PREVIEW.bytes.length }).plan)
})

test('minor is computed from the table; a value it lacks fails', () => {
    assert.equal(
        minorOf({
            levelVersion: 1,
            rootVs: [1],
            manifestVersion: 1,
            entryKinds: ['save'],
            zipEntries: ['project.json', 'bgm/a.mp3'],
        }),
        0,
    )
    assert.throws(() =>
        minorOf({
            levelVersion: 1,
            rootVs: [],
            manifestVersion: 2,
            entryKinds: [],
            zipEntries: [],
        }),
    )
    assert.throws(() => minorOf({ levelVersion: 2, rootVs: [], entryKinds: [], zipEntries: [] }))
    assert.throws(() => minorOf({ levelVersion: 1, rootVs: [2], entryKinds: [], zipEntries: [] }))
    assert.throws(() =>
        minorOf({ levelVersion: 1, rootVs: [], entryKinds: ['merge'], zipEntries: [] }),
    )
    assert.throws(() =>
        minorOf({ levelVersion: 1, rootVs: [], entryKinds: [], zipEntries: ['video/a.mp4'] }),
    )
})

test('project.json: patch follows minor, written always, from the patch table', () => {
    const { plan, project } = planNxsp(fresh().input)
    const written = jsonPart(plan, 'project.json')
    assert.deepEqual(Object.keys(written).slice(0, 4), ['format', 'version', 'minor', 'patch'])
    assert.equal(written.patch, 0)
    assert.equal(project.patch, 0)
    // A write without history writes it too.
    const noHistory = { ...fresh().input }
    Reflect.deleteProperty(noHistory, 'history')
    assert.equal(jsonPart(planNxsp(noHistory).plan, 'project.json').patch, 0)
    // A zip entry the patch table lacks is refused, as the minor table's is.
    assert.throws(() => patchOf({ zipEntries: ['video/a.mp4'] }))
    assert.equal(patchOf({ zipEntries: ['project.json', 'bgm/a.mp3'] }), 0)
})

test('a save entry records the app version that wrote it, and only a save entry does', () => {
    const { plan } = planNxsp(fresh().input)
    const manifest = jsonPart(plan, 'history/manifest.json')
    const kinds = manifest.entries.map((e: Loose) => [e.kind, e.appVersion])
    assert.deepEqual(kinds, [
        ['init', undefined],
        ['edit', undefined],
        ['edit', undefined],
        ['save', '0.6.0'],
    ])
    // Carried as it is held: an entry from before the version was recorded stays without one.
    const input = fresh().input
    const history = input.history as NonNullable<typeof input.history>
    const entries = history.entries.map((e) => {
        if (e.kind !== 'save') return e
        const rest = { ...e }
        Reflect.deleteProperty(rest, 'appVersion')
        return rest
    })
    const old = planNxsp({ ...input, history: { ...history, entries } })
    const oldManifest = jsonPart(old.plan, 'history/manifest.json')
    assert.equal(oldManifest.entries.at(-1).appVersion, undefined)
    // On any other kind it is a foreign key, which the builder's own check against the reader refuses.
    const foreign = history.entries.map((e, i) =>
        i === 1 ? ({ ...e, appVersion: '0.6.0' } as EntryForm) : e,
    )
    assert.throws(
        () => planNxsp({ ...input, history: { ...history, entries: foreign } }),
        /The history breaks v1: manifest\.entries\[1\]\.appVersion/,
    )
})

test('the same input gives the same plan', () => {
    const a = planNxsp(fresh().input)
    const b = planNxsp(fresh().input)
    assert.deepEqual(a.plan, b.plan)
    assert.deepEqual(a.plan.modified, {
        dosTime: (5 << 11) | (41 << 5) | 3,
        dosDate: ((2026 - 1980) << 9) | (10 << 5) | 16,
    })
})

test('project names are written well-formed and malformed operation text is refused', () => {
    const { input } = fresh()
    const history = input.history
    assert.ok(history)
    const { project } = planNxsp({ ...input, name: 'name \udc00' })
    assert.equal(project.name, 'name �')
    const entries = history.entries.map((e, i) =>
        i === 1 && e.kind === 'edit'
            ? {
                  ...e,
                  step: {
                      kind: 'edit' as const,
                      operation: {
                          id: 'test.future.malformed-text',
                          version: 1,
                          data: {},
                          fallback: { text: 'bad \ud800 fallback', locale: 'en' },
                      },
                  },
              }
            : e,
    )
    assert.throws(() => planNxsp({ ...input, history: { ...history, entries } }), PlanError)
})

test('extra keys named __proto__ are written back', () => {
    const { input } = fresh()
    const extra = JSON.parse(
        '{"__proto__":{"a":1},"metadata":{"__proto__":2}}',
    ) as BuildInput['extra']
    const { project } = planNxsp({ ...input, extra })
    const text = JSON.stringify(project)
    assert.match(text, /"__proto__":\{"a":1\}/)
    assert.match(text, /"__proto__":2/)
})

test('x through the append writer: carried on entries and steps, copied with a segment, dropped from a rebuilt manifest and undo stack', async () => {
    const x = { future: [1, { deep: true }], note: 'kept' }
    const chain = longChain(500)
    const head = chain.hashes[0] as string
    const saveRow = (time: number) =>
        entry(
            { kind: 'save', operation: futureFixtureOperation('segmented-save', {}, 'Saved') },
            time,
            head,
            {
                revisionId: 's001-0000-4000-8000-000000000000',
                device: DEVICE,
                appVersion: '0.6.0',
            },
        )
    const first = await executePlan(planNxsp(chain.input).plan, new Map())
    // The first file as a later build would have written it: `x` on every carrier.
    const withX = await crafted((items) => {
        const m = jsonOf(items, 'history/manifest.json')
        m.x = x
        m.undoStack.x = x
        m.undoStack.slots[0].x = x
        m.undoStack.slots[0].step.x = x
        m.entries[1].x = x
        m.entries[1].step.x = x
        setJson(items, 'history/manifest.json', m)
    }, first)
    const readX = await readNxsp(withX)
    assert.ok(readX.kind === 'nxsp' && readX.open === 'full')

    // Append: the 500-entry manifest becomes a segment, re-serialized from its entries.
    const source = await inspectNxsp(withX, { token: 't', role: 'target', fingerprint: 'f' })
    const second = planNxsp(appendInput(chain.input, source, [saveRow(9000)], head), [source])
    assert.equal(jsonPart(second.plan, 'project.json').patch, 0)
    const file2 = await executePlan(second.plan, new Map([['t', memorySource(withX, 'f')]]))
    const written = await unzip(file2)
    const segment = jsonOf(written.items, 'history/segments/1.json')
    assert.deepEqual(segment.entries[1].x, x)
    assert.deepEqual(segment.entries[1].step.x, x)
    assert.equal(segment.x, undefined)
    const manifest = jsonOf(written.items, 'history/manifest.json')
    assert.equal(manifest.x, undefined)
    assert.equal(manifest.undoStack.x, undefined)
    assert.equal(manifest.undoStack.slots[0].x, undefined)
    const read2 = await readNxsp(file2)
    assert.ok(read2.kind === 'nxsp')
    assert.deepEqual(read2.report, [])
    assert.deepEqual(read2.history?.entries[1]?.x, x)

    // A segment is copied whole, so whatever it holds, a part-level `x` included, stays.
    const withSegmentX = await crafted((items) => {
        const part = jsonOf(items, 'history/segments/1.json')
        part.x = x
        part.entries[2].step.x = x
        setJson(items, 'history/segments/1.json', part)
    }, file2)
    const source2 = await inspectNxsp(withSegmentX, {
        token: 'u',
        role: 'target',
        fingerprint: 'g',
    })
    const third = planNxsp(appendInput(chain.input, source2, [saveRow(9100)], head), [source2])
    assert.equal(
        third.plan.entries.find((e) => e.name === 'history/segments/1.json')?.parts[0]?.kind,
        'copy',
    )
    const file3 = await executePlan(third.plan, new Map([['u', memorySource(withSegmentX, 'g')]]))
    const kept = jsonOf((await unzip(file3)).items, 'history/segments/1.json')
    assert.deepEqual(kept.x, x)
    assert.deepEqual(kept.entries[2].step.x, x)
    const read3 = await readNxsp(file3)
    assert.ok(read3.kind === 'nxsp')
    assert.deepEqual(read3.report, [])
    assert.deepEqual(read3.history?.entries[1]?.x, x)
})

test('the writer finds every x carrier it holds, carried ones too, for the patch table', async () => {
    const x = { a: 1 }
    const found = (part: unknown) => [...carriersIn(part)].sort()
    assert.deepEqual(found({ entries: [], x }), ['part.x'])
    const step = { kind: 'edit', operation: null, x }
    assert.deepEqual(
        found({
            entries: [
                { kind: 'edit', step, x },
                {
                    kind: 'recovered',
                    recoveryContext: {
                        head: { kind: 'edit', operation: null, x },
                        headIndex: 0,
                        dropped: [{ kind: 'edit', operation: null }],
                        omitted: 0,
                        x,
                    },
                    stack: { keep: 0, push: [{ snapshot: 'a', step, x }], index: 0, x },
                },
            ],
            undoStack: {
                base: 0,
                slots: [{ snapshot: 'a', step: { ...step, x: undefined }, x }],
                index: 0,
                x,
            },
        }),
        ['context.x', 'entry.x', 'item.x', 'slot.x', 'stack.x', 'step.x', 'undoStack.x'],
    )
    assert.deepEqual(
        found({ entries: [{ kind: 'edit', step: { kind: 'edit', operation: null } }] }),
        [],
    )
    assert.deepEqual(found(null), [])
})
