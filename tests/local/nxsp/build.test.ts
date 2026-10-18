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
import { minorOf } from '../../../src/local/nxsp/version'
import { stateOf } from '../records/charts'
import { fresh, NOW } from './chain'
import type { Loose } from './craft'
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
        entries.push(entry(i ? 'edit' : 'init', 1000 + i, `Step ${i}`, snapshot))
    }
    const head = hashes[(count - 2) % 3] as string
    entries.push(
        entry('save', 1000 + count, 'Saved', head, {
            revisionId: 'r001-0000-4000-8000-000000000000',
            device: DEVICE,
        }),
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
            undoStack: { base: 0, slots: [{ snapshot: head, label: 'Saved' }], index: 0 },
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
            undoStack: { base: 0, slots: [{ snapshot: head, label: 'x' }], index: 0 },
        },
    }
}

test('an append: a source manifest of 500 or more becomes a segment; fewer are carried into the manifest', async () => {
    const chain = longChain(500)
    const first = await executePlan(planNxsp(chain.input).plan, new Map())
    const source = await inspectNxsp(first, { token: 't', role: 'target', fingerprint: 'f' })
    const head = chain.hashes[0] as string
    const rows = [
        entry('continue', 9000, 'Continued', head),
        entry('save', 9001, 'Saved', head, {
            revisionId: 's001-0000-4000-8000-000000000000',
            device: DEVICE,
        }),
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
        entry('save', 9100, 'Saved', head, {
            revisionId: 's001-0000-4000-8000-000000000000',
            device: DEVICE,
        }),
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
    entries.splice(1, 0, entry('edit', 1500, 'Thinned', thinned, { kept: false }))
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
    assert.throws(() => minorOf({ levelVersion: 2, rootVs: [], entryKinds: [], zipEntries: [] }))
    assert.throws(() => minorOf({ levelVersion: 1, rootVs: [2], entryKinds: [], zipEntries: [] }))
    assert.throws(() =>
        minorOf({ levelVersion: 1, rootVs: [], entryKinds: ['merge'], zipEntries: [] }),
    )
    assert.throws(() =>
        minorOf({ levelVersion: 1, rootVs: [], entryKinds: [], zipEntries: ['video/a.mp4'] }),
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

test('strings are written well-formed', () => {
    const { input } = fresh()
    const history = input.history
    assert.ok(history)
    const entries = history.entries.map((e, i) =>
        i === 1 ? { ...e, label: 'bad \ud800 label' } : e,
    )
    const { project, plan } = planNxsp({
        ...input,
        name: 'name \udc00',
        history: { ...history, entries },
    })
    assert.equal(project.name, 'name �')
    assert.equal(jsonPart(plan, 'history/manifest.json').entries[1].label, 'bad � label')
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
