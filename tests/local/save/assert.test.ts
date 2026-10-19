import { futureFixtureOperation } from '../../helpers/historySteps'
import assert from 'node:assert/strict'
import test from 'node:test'
import { deflateRaw, inflateRaw } from 'pako'
import type { PlannedEntry, WritePlan } from '../../../src/local/nxsp/plan'
import { setSaveHooksForTests } from '../../../src/local/save/build'
import { nxspDiskState } from '../../../src/platform/fingerprint'
import { crc32 } from '../../../src/zip/crc32'
import { Fixture, save, sourceOf, stateAt } from './fixture'

// The append assertion (§1.6.11.6 step 3; §1.11.6's Exit: "fails a plan whose prefix a test hook
// altered"): every alteration of the copied prefix is a plan error, with nothing written.

const diskOf = (file: File) => nxspDiskState(file, file.lastModified).then((disk) => ({ ...disk }))

type Json = Record<string, unknown> & {
    history: { segments: string[]; entries: number; manifest: string; chunks: string }
}

const decode = (entry: PlannedEntry) => {
    const [part] = entry.parts
    assert.ok(part?.kind === 'bytes')
    const raw = entry.method === 8 ? inflateRaw(part.data) : part.data
    return JSON.parse(new TextDecoder().decode(raw)) as unknown
}

const encode = (entry: PlannedEntry, value: unknown): PlannedEntry => {
    const bytes = new TextEncoder().encode(JSON.stringify(value))
    return {
        ...entry,
        crc32: crc32(bytes) >>> 0,
        uncompressedSize: bytes.length,
        parts: [{ kind: 'bytes', data: entry.method === 8 ? deflateRaw(bytes) : bytes }],
    }
}

/** A plan with one JSON entry rewritten, its CRC and size fixed. */
const rewrite =
    <T>(name: (plan: WritePlan) => string, change: (value: T) => void) =>
    (plan: WritePlan): WritePlan => {
        const target = name(plan)
        return {
            ...plan,
            entries: plan.entries.map((entry) => {
                if (entry.name !== target) return entry
                const value = decode(entry) as T
                change(value)
                return encode(entry, value)
            }),
        }
    }

const projectOf = (plan: WritePlan) =>
    decode(plan.entries.find((entry) => entry.name === 'project.json')!) as Json

const project = (change: (value: Json) => void) => rewrite<Json>(() => 'project.json', change)

const manifest = (change: (value: Record<string, Record<string, unknown>>) => void) =>
    rewrite((plan) => projectOf(plan).history.manifest, change)

const entry =
    (name: string, change: (entry: PlannedEntry) => PlannedEntry | undefined) =>
    (plan: WritePlan): WritePlan => ({
        ...plan,
        entries: plan.entries.flatMap((each) => {
            if (each.name !== name) return [each]
            const changed = change(each)
            return changed ? [changed] : []
        }),
    })

/** A bound file of two segments and a manifest, and a later edit to write back. */
const setUp = async (pairs = 520) => {
    const fixture = await Fixture.create()
    await fixture.start(0)
    await fixture.edit(1)
    for (let i = 0; i < pairs; i++) {
        fixture.undo()
        fixture.redo()
    }
    await fixture.flush()
    const first = await save(fixture, { kind: 'copy' }, { disk: diskOf })
    assert.ok(!('refused' in first.built) && first.file)
    await fixture.edit(2)
    await fixture.flush()
    return { fixture, file: first.file }
}

const alterations: [string, (plan: WritePlan) => WritePlan][] = [
    [
        'segments reordered in project.json',
        project((value) => {
            const [a, b] = value.history.segments
            value.history.segments = [b!, a!, ...value.history.segments.slice(2)]
        }),
    ],
    [
        'a segment renamed',
        (plan) =>
            entry('history/segments/1.json', (each) => ({
                ...each,
                name: 'history/segments/9.json',
            }))(
                project((value) => {
                    value.history.segments[0] = 'history/segments/9.json'
                })(plan),
            ),
    ],
    [
        'a segment dropped',
        (plan) =>
            entry(
                'history/segments/1.json',
                () => undefined,
            )(
                project((value) => {
                    value.history.segments.shift()
                })(plan),
            ),
    ],
    [
        'a segment rewritten rather than copied',
        entry('history/segments/1.json', (each) => {
            const [part] = each.parts
            assert.ok(part?.kind === 'copy')
            return {
                ...each,
                method: 0,
                parts: [{ kind: 'bytes', data: new TextEncoder().encode('{"entries":[]}') }],
            }
        }),
    ],
    [
        'a carried row changed',
        manifest((value) => {
            const rows = value.entries as unknown as { operation?: unknown; step?: {operation:unknown} }[]
            const row = rows[0]!
            if (row.step) row.step.operation = futureFixtureOperation('changed-carried-row')
            else row.operation = futureFixtureOperation('changed-carried-row')
        }),
    ],
    [
        'history.entries miscounted',
        project((value) => {
            value.history.entries += 1
        }),
    ],
    [
        'chunks.bin copied with inflate',
        entry('history/chunks.bin', (each) => ({
            ...each,
            parts: each.parts.map((part) =>
                part.kind === 'copy' ? { ...part, inflate: true as const } : part,
            ),
        })),
    ],
    [
        'a segment copied with inflate',
        entry('history/segments/2.json', (each) => ({
            ...each,
            parts: each.parts.map((part) =>
                part.kind === 'copy' ? { ...part, inflate: true as const } : part,
            ),
        })),
    ],
    [
        'history.chunks pointing past the checked copy',
        (plan) => {
            const chunks = plan.entries.find((each) => each.name === 'history/chunks.bin')!
            const other: PlannedEntry = {
                ...chunks,
                name: 'history/other.bin',
                parts: chunks.parts.filter((part) => part.kind === 'bytes'),
            }
            return project((value) => {
                value.history.chunks = 'history/other.bin'
            })({ ...plan, entries: [...plan.entries, other] })
        },
    ],
]

const refusesEach = async (
    { fixture, file }: Awaited<ReturnType<typeof setUp>>,
    cases: typeof alterations,
) => {
    for (const [name, alter] of cases) {
        setSaveHooksForTests({ plan: alter })
        try {
            const { built, file: written } = await save(
                fixture,
                { kind: 'append', source: 'target' },
                { files: [await sourceOf(file)], binds: false },
            )
            assert.ok('refused' in built, `${name}: built`)
            assert.equal(built.refused, 'plan', name)
            assert.match(built.message ?? '', /Not an append/, name)
            assert.equal(written, undefined)
        } finally {
            setSaveHooksForTests({})
        }
    }
    // Unaltered, the same write-back is an append.
    const { built } = await save(
        fixture,
        { kind: 'append', source: 'target' },
        { files: [await sourceOf(file)], binds: false },
    )
    assert.ok(!('refused' in built), JSON.stringify(built))
}

test('the append assertion fails every alteration of the copied prefix, as a plan error', async () => {
    await refusesEach(await setUp(), alterations)
})

test('a root the source’s manifest holds, changed in the new manifest, is a plan error', async () => {
    // A short source: its manifest holds the roots of its rows.
    await refusesEach(await setUp(2), [
        [
            'a carried root changed',
            manifest((value) => {
                const roots = value.roots!
                assert.ok(roots[stateAt(0).hex])
                roots[stateAt(0).hex] = [1, '0'.repeat(32), [], 0]
            }),
        ],
    ])
})
