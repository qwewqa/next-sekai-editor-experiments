import type { LevelDataEntity } from '@sonolus/core'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import Type from 'typebox'
import Value from 'typebox/value'
import {
    parseLevelDataChart,
    setParserReadHook,
    type ParserRead,
} from '../../src/chart/parse/levelData'
import { check } from '../../src/chart/parse/levelData/check'
import { isNoteEntity, noteArchetypeNames } from '../../src/chart/parse/levelData/slide'
import { ImportRefusal } from '../../src/chart/refusal'
import { serializeToLevelDataEntities } from '../../src/levelData/entities/serialize'
import {
    ignoredArchetypes,
    ignoredFields,
    knownArchetypes,
    tableLevelVersion,
    noteArchetypeNames as tableNoteNames,
    type Ignored,
} from '../../src/levelData/known'
import { LEVEL_VERSION } from '../../src/levelData/levelVersion'
import { parseLevelData } from '../../src/levelData/parse'
import {
    LevelDataReport,
    reportLevelDataEntities,
    resetAllowedFieldsForTests,
} from '../../src/levelData/report'
import { LATEST_REVISION } from '../../src/levelData/revision'
import { createState } from '../../src/state'
import { pinned } from './levelDataPin'
import { entity, fullLevel, minimalLevel, nestedFolder, noteData, ref } from './levelDataSynthetic'
import { tableAt } from './levelDataTable'

const parse = (entities: LevelDataEntity[]) => {
    const report = new LevelDataReport()
    const chart = parseLevelDataChart(entities, [], undefined, report)
    return { chart, report }
}

/** The level with a field set to a value on every entity of the archetype. */
const withData = (
    entities: LevelDataEntity[],
    archetype: string,
    name: string,
    value: number,
): LevelDataEntity[] =>
    entities.map((e) =>
        e.archetype === archetype
            ? { ...e, data: [...e.data.filter((d) => d.name !== name), { name, value }] }
            : e,
    )

const refusal = (reason: string, field?: string) => (error: unknown) =>
    error instanceof ImportRefusal &&
    error.reason === reason &&
    (field === undefined || error.params[0] === field)

// Coconut is local-only (never committed); CI runs these on the committed generated chart.
const coconutPath = 'test_level_data/coconut-next-sekai-24887.json'
const coconut = () => parseLevelData(JSON.parse(readFileSync(coconutPath, 'utf8'))).entities
const generated = () =>
    parseLevelData(JSON.parse(readFileSync('tests/fixtures/generated-large.json', 'utf8'))).entities
const committed = () => [...(existsSync(coconutPath) ? [coconut()] : []), generated()]

test('the synthetic levels parse and report nothing', () => {
    assert.ok(parse(minimalLevel()).report.isEmpty)
    const { chart, report } = parse(fullLevel())
    assert.deepEqual(report.entries, [])
    assert.ok(chart.isDynamicStages)
    assert.equal(chart.cameraEvents.length, 2)
    assert.equal(chart.stageMaskEvents.length, 2)
    assert.equal(chart.slides.length, 2)
})

test('the committed levels report nothing', () => {
    for (const entities of committed()) {
        const { chart, report } = parse(entities)
        assert.deepEqual(report.entries, [])
        assert.ok(chart.slides.length > 0)
    }
})

test('an unknown archetype is reported with its count, and the level still parses', () => {
    const entities = [
        ...minimalLevel(),
        entity('Unheard', { '#BEAT': 1, effect: 1, level: 1 }),
        entity('Unheard', { '#BEAT': 2, effect: 1, level: 1 }),
        entity('SomethingNew', { a: 1 }),
    ]
    const { chart, report } = parse(entities)
    assert.deepEqual(report.entries, [
        { kind: 'archetype', archetype: 'Unheard', count: 2 },
        { kind: 'archetype', archetype: 'SomethingNew', count: 1 },
    ])
    assert.equal(chart.slides.length, 1)
})

test('Skill, FeverChance and FeverStart are dropped silently, as before (D2)', () => {
    for (const archetype of ['Skill', 'FeverChance', 'FeverStart']) {
        assert.ok(!Object.hasOwn(knownArchetypes, archetype))
        assert.equal(ignoredArchetypes[archetype]?.reason, 'dropped')
        const report = new LevelDataReport()
        reportLevelDataEntities([entity(archetype, { '#BEAT': 1 })], report)
        assert.deepEqual(report.entries, [])
    }
})

test('an unknown field on a known archetype is reported', () => {
    const entities = minimalLevel().map((e) =>
        e.archetype === '#BPM_CHANGE'
            ? { ...e, data: [...e.data, { name: 'swing', value: 1 }] }
            : e,
    )
    assert.deepEqual(parse(entities).report.entries, [
        { kind: 'field', archetype: '#BPM_CHANGE', field: 'swing', count: 1 },
    ])
})

test('an unknown field is counted per archetype and field', () => {
    const entities = [
        ...minimalLevel(),
        entity('NormalTapNote', { ...noteData(), glow: 1 }),
        entity('NormalFlickNote', { ...noteData(), glow: 1 }),
        entity('NormalFlickNote', { ...noteData(), glow: 2 }),
    ]
    assert.deepEqual(parse(entities).report.entries, [
        { kind: 'field', archetype: 'NormalTapNote', field: 'glow', count: 1 },
        { kind: 'field', archetype: 'NormalFlickNote', field: 'glow', count: 2 },
    ])
})

test('names that exist on Object.prototype are unknown, not known', () => {
    const entities = [
        ...minimalLevel(),
        entity('constructor', {}),
        entity('__proto__', {}),
        entity('#BPM_CHANGE', { '#BEAT': 1, '#BPM': 120, constructor: 1, toString: 1 }),
    ]
    assert.deepEqual(parse(entities).report.entries, [
        { kind: 'archetype', archetype: 'constructor', count: 1 },
        { kind: 'archetype', archetype: '__proto__', count: 1 },
        { kind: 'field', archetype: '#BPM_CHANGE', field: 'constructor', count: 1 },
        { kind: 'field', archetype: '#BPM_CHANGE', field: 'toString', count: 1 },
    ])
})

test('the known-but-ignored archetypes and fields are not reported', () => {
    // The full level carries each of them.
    const level = fullLevel()
    const report = new LevelDataReport()
    reportLevelDataEntities(level, report)
    assert.deepEqual(report.entries, [])

    const archetypes = new Set(level.map(({ archetype }) => archetype))
    for (const archetype of Object.keys(ignoredArchetypes)) assert.ok(archetypes.has(archetype))
    for (const [archetype, fields] of Object.entries(ignoredFields)) {
        // Note archetypes share their ignored fields, and the full level has some notes.
        const carriers = level.filter(
            (e) => e.archetype === archetype || archetype.endsWith('Note'),
        )
        for (const field of Object.keys(fields))
            assert.ok(
                carriers.some((e) => e.data.some((d) => d.name === field)),
                `${archetype}.${field}`,
            )
    }
})

test('a newer engine revision is reported, an equal or missing one is not', () => {
    const at = (revision?: number) =>
        parse(
            minimalLevel().map((e) =>
                e.archetype === 'Initialization'
                    ? {
                          ...e,
                          data:
                              revision === undefined ? [] : [{ name: 'revision', value: revision }],
                      }
                    : e,
            ),
        ).report.entries
    assert.deepEqual(at(LATEST_REVISION + 1), [{ kind: 'revision', revision: LATEST_REVISION + 1 }])
    assert.deepEqual(at(LATEST_REVISION), [])
    assert.deepEqual(at(1), [])
    assert.deepEqual(at(undefined), [])
})

// What a new object of each choice gets, as the parser's output shows it.
test('an unknown choice value gives a report entry and the field’s default', () => {
    const unknown = 9999
    const run = (archetype: string, name: string, value = unknown) => {
        const { chart, report } = parse(withData(fullLevel(), archetype, name, value))
        const count = fullLevel().filter((e) => e.archetype === archetype).length
        assert.deepEqual(report.entries, [{ kind: 'value', archetype, field: name, value, count }])
        return chart
    }

    // A note reads some of these more than once; each still counts once.
    const note = (name: string) =>
        run('NormalHeadFlickNote', name).slides.find((s) => s.length === 2)?.[0]
    assert.equal(note('style')?.noteStyle, 'default')
    assert.equal(note('effectKind')?.sfx, 'default')
    assert.equal(note('connectorEase')?.connectorEase, 'linear')
    assert.equal(note('segmentLayer')?.connectorLayer, 'top')
    assert.equal(note('segmentPresentation')?.connectorPresentation, 'default')
    assert.equal(note('segmentKind')?.connectorType, 'active')
    assert.equal(note('segmentKind')?.connectorIsFake, false)
    assert.equal(note('segmentKind')?.connectorActiveIsCritical, false)
    assert.equal(note('direction')?.flickDirection, 'up')

    assert.equal(
        run('#TIMESCALE_CHANGE', '#TIMESCALE_EASE', 30).timeScales[0]?.timeScaleEase,
        'none',
    )
    assert.equal(
        run('#TIMESCALE_CHANGE', 'transitionStyle').timeScales[0]?.timeScaleTransition,
        'timeScale',
    )
    for (const value of [13, 0.5, -1])
        assert.equal(
            [...run('#TIMESCALE_GROUP', 'forceNoteSpeed', value).groups.values()][0]
                ?.forceNoteSpeed,
            undefined,
        )
    assert.equal(
        [...run('Stage', 'generateSimLines').stages.values()][0]?.generateSimLines,
        'global',
    )

    assert.equal(run('CameraChange', 'ease').cameraEvents[0]?.eventEase, 'linear')
    assert.equal(
        run('CameraChange', 'zoomVerticalAlign').cameraEvents[0]?.cameraZoomVerticalAlign,
        'default',
    )
    assert.equal(run('StageMaskChange', 'ease').stageMaskEvents[0]?.eventEase, 'linear')
    assert.equal(
        run('StagePivotChange', 'divisionParity').stagePivotEvents[0]?.divisionParity,
        'even',
    )
    assert.equal(run('StagePivotChange', 'ease').stagePivotEvents[0]?.eventEase, 'linear')
    const style = (name: string) => run('StageStyleChange', name).stageStyleEvents[0]
    assert.equal(style('judgeLineColor')?.judgmentLineColor, 'purple')
    assert.equal(style('judgeLineStyle')?.judgmentLineStyle, 'default')
    assert.equal(style('leftBorderStyle')?.leftBorderStyle, 'default')
    assert.equal(style('rightBorderStyle')?.rightBorderStyle, 'default')
    assert.equal(style('ease')?.eventEase, 'linear')
    assert.equal(run('StageTransformChange', 'anchor').stageTransformEvents[0]?.anchor, 'default')
    assert.equal(run('StageTransformChange', 'ease').stageTransformEvents[0]?.eventEase, 'linear')
})

test('every choice field in the table takes the unknown-value path', () => {
    let fields = 0
    for (const [archetype, known] of Object.entries(knownArchetypes)) {
        // Notes share one field set, so one archetype stands for them.
        if (archetype.endsWith('Note') && archetype !== 'NormalHeadFlickNote') continue
        for (const [name, field] of Object.entries(known.fields)) {
            if (!field.choice) continue
            fields++
            const entities = withData(fullLevel(), archetype, name, 9999)
            const report = new LevelDataReport()
            parseLevelDataChart(entities, [], undefined, report)
            const count = fullLevel().filter((e) => e.archetype === archetype).length
            assert.deepEqual(
                report.entries,
                [{ kind: 'value', archetype, field: name, value: 9999, count }],
                `${archetype}.${name}`,
            )
            // Without a report the level is refused, as before.
            assert.throws(
                () => parseLevelDataChart(entities),
                refusal('unknownValue', name),
                `${archetype}.${name}`,
            )
        }
    }
    assert.ok(fields >= 20)
})

test('a note style or force note speed from a newer editor is unknown, not invalid', () => {
    // Before the table drove them, both were refused as invalid values.
    const style = withData(minimalLevel(), 'NormalTapNote', 'style', 9)
    assert.throws(() => parseLevelDataChart(style))
    assert.throws(() => parseLevelDataChart(style), refusal('unknownValue', 'style'))
    assert.deepEqual(parse(style).report.entries, [
        { kind: 'value', archetype: 'NormalTapNote', field: 'style', value: 9, count: 1 },
    ])
    assert.equal(parse(style).chart.slides[0]?.[0]?.noteStyle, 'default')

    const speed = withData(fullLevel(), '#TIMESCALE_GROUP', 'forceNoteSpeed', 13)
    assert.throws(() => parseLevelDataChart(speed), refusal('unknownValue', 'forceNoteSpeed'))
})

test('forceNoteSpeed keeps its decimals', () => {
    const group = [...parse(fullLevel()).chart.groups.values()][0]
    assert.equal(group?.forceNoteSpeed, 3.5)
})

test('a report holding an unknown choice value can refuse as before', () => {
    const { report } = parse(withData(minimalLevel(), 'NormalTapNote', 'connectorEase', 99))
    assert.ok(report.hasUnknownValue)
    assert.throws(() => report.refuseUnknownValues(), refusal('unknownValue', 'connectorEase'))
    assert.doesNotThrow(() => new LevelDataReport().refuseUnknownValues())
})

test('a value that is not a choice is still invalid, with or without a report', () => {
    const entities = withData(minimalLevel(), 'NormalTapNote', 'size', -1)
    assert.throws(() => parseLevelDataChart(entities), refusal('invalidValue', 'size'))
    assert.throws(
        () => parseLevelDataChart(entities, [], undefined, new LevelDataReport()),
        refusal('invalidValue', 'size'),
    )
})

test('a refusal leaves no report for the next parse', () => {
    assert.throws(() =>
        parseLevelDataChart(
            withData(minimalLevel(), 'NormalTapNote', 'size', -1),
            [],
            undefined,
            new LevelDataReport(),
        ),
    )
    // No report is active now, so an unknown choice value refuses.
    assert.throws(
        () => parseLevelDataChart(withData(minimalLevel(), 'NormalTapNote', 'style', 9)),
        refusal('unknownValue'),
    )
})

test('the table and the level version agree, and the pinned snapshots are current', () => {
    assert.equal(tableLevelVersion(), LEVEL_VERSION)
    assert.equal(Math.max(...Object.keys(pinned).map(Number)), LEVEL_VERSION)
    // Each version's table is frozen once released: adding to it without a bump fails here.
    for (const [version, snapshot] of Object.entries(pinned))
        assert.deepEqual(tableAt(Number(version)), snapshot, `levelVersion ${version}`)
})

test('every version tag in the table is a version that exists', () => {
    for (const [archetype, known] of Object.entries(knownArchetypes)) {
        for (const [name, field] of Object.entries(known.fields)) {
            const where = `${archetype}.${name}`
            const tags = [
                known.since ?? 1,
                field.since ?? 1,
                ...Object.values(field.choice?.values ?? {}),
                ...(field.choice?.ranges ?? []).map(({ since }) => since),
            ]
            for (const since of tags)
                assert.ok(Number.isInteger(since) && since >= 1 && since <= LEVEL_VERSION, where)

            const choice = field.choice
            if (!choice) continue
            const accepted =
                Object.hasOwn(choice.values, choice.default) ||
                (choice.ranges ?? []).some(
                    ({ min, max }) => choice.default >= min && choice.default <= max,
                )
            assert.ok(accepted, `${where} default is one of its values`)
        }
    }
})

// The table is the authority; this is the test-only check that the parser agrees with it.
test('the parser’s reads agree with the declared table', () => {
    const reads = new Map<string, ParserRead[]>()
    setParserReadHook((read) => {
        const key = `${read.archetype}.${read.name}`
        reads.set(key, [...(reads.get(key) ?? []), read])
    })
    try {
        for (const entities of [[...fullLevel(), nestedFolder()], ...committed()]) parse(entities)
    } finally {
        setParserReadHook(undefined)
    }

    const problems: string[] = []
    for (const [key, list] of reads) {
        const read = list[0]
        const field = read && knownArchetypes[read.archetype]?.fields[read.name]
        if (!read || !field) {
            problems.push(`${key} is read but not in the table`)
            continue
        }
        if (field.kind !== read.kind) problems.push(`${key} is a ${field.kind} in the table`)
        if (list.some((r) => r.required) !== !!field.required)
            problems.push(`${key} is ${field.required ? 'required' : 'optional'} in the table`)

        // The schema's own literals are the choice's values; a range is probed at its edges.
        const schema = list.find((r) => r.schema)?.schema as
            (Type.TSchema & { anyOf?: { const?: unknown }[] }) | undefined
        const literals = schema?.anyOf?.every((option) => typeof option.const === 'number')
            ? schema.anyOf.map((option) => option.const as number)
            : undefined
        if (literals) {
            if (!field.choice) problems.push(`${key} is a choice in the parser only`)
            const declared = Object.keys(field.choice?.values ?? {}).map(Number)
            assert.deepEqual(
                [...literals].sort((a, b) => a - b),
                [...declared].sort((a, b) => a - b),
                `${key} values`,
            )
        } else if (schema && field.choice) {
            for (const value of Object.keys(field.choice.values).map(Number))
                assert.ok(Value.Check(schema, value), `${key} accepts ${value}`)
            for (const { min, max } of field.choice.ranges ?? []) {
                assert.ok(Value.Check(schema, min) && Value.Check(schema, max), `${key} range`)
                assert.ok(!Value.Check(schema, max + 0.001), `${key} above its range`)
                assert.ok(!Value.Check(schema, min - 0.001), `${key} below its range`)
            }
        } else if (field.choice) {
            problems.push(`${key} is a choice in the table only`)
        }
    }

    // Everything the table declares is read, except what is read outside the four helpers.
    const readElsewhere = new Set(['Initialization.revision'])
    for (const [archetype, known] of Object.entries(knownArchetypes)) {
        // Notes share one field set, and the corpora have most of the archetypes.
        if (archetype.endsWith('Note') && !reads.has(`${archetype}.#BEAT`)) continue
        for (const name of Object.keys(known.fields)) {
            const key = `${archetype}.${name}`
            if (!readElsewhere.has(key) && !reads.has(key))
                problems.push(`${key} is in the table but never read`)
        }
    }
    assert.deepEqual(problems, [])
})

test('the compiled checks answer as Value.Check does', () => {
    const schemas = new Set<Type.TSchema>()
    setParserReadHook((read) => read.schema && schemas.add(read.schema))
    try {
        for (const entities of [fullLevel(), ...committed()]) parse(entities)
    } finally {
        setParserReadHook(undefined)
    }
    assert.ok(schemas.size > 20)

    const probes: unknown[] = [
        ...[-1, -0.001, 0, 0.001, 0.01, 0.5, 1, 1.5, 2, 3, 6, 10.85, 12, 12.001, 13, 100, 999],
        ...[NaN, Infinity, -Infinity, 1e308, -0, 2 ** 53],
        ...['0', '1', '', 'a', null, undefined, true, false, [], [1], {}, 1n],
        ...Array.from({ length: 120 }, (_, i) => i),
    ]
    for (const schema of schemas)
        for (const probe of probes)
            assert.equal(
                check(schema, probe),
                Value.Check(schema, probe),
                `${JSON.stringify(schema)} ${String(probe)}`,
            )
})

test('the editor’s own export of the committed levels reports nothing', () => {
    for (const entities of committed()) {
        const { chart } = parse(entities)
        const state = createState(chart, 0)
        const exported = serializeToLevelDataEntities(
            state.initialLife,
            state.isDynamicStages,
            state.store,
            state.groups,
            state.stages,
            { groups: state.groupFolders, stages: state.stageFolders },
        )
        const report = new LevelDataReport()
        reportLevelDataEntities(exported, report)
        assert.deepEqual(report.entries, [])
        assert.deepEqual(parse(exported).report.entries, [])
    }
})

test('a nested folder is reported, and still shown in its top-level folder', () => {
    for (const archetype of ['EditorGroupFolder', 'EditorStageFolder']) {
        const entities = [
            ...minimalLevel(),
            entity(archetype, { editorName: ref('Top'), editorIndex: 0 }, 'f0'),
            entity(
                archetype,
                { editorName: ref('Inner'), editorIndex: 1, editorFolder: ref('f0') },
                'f1',
            ),
        ]
        const { chart, report } = parse(entities)
        assert.deepEqual(report.entries, [
            { kind: 'field', archetype, field: 'editorFolder', count: 1 },
        ])
        assert.ok(chart)
    }
})

test('a repeated data entry on a known field is reported', () => {
    const entities = minimalLevel().map((e) =>
        e.archetype === '#BPM_CHANGE'
            ? { ...e, data: [...e.data, { name: 'meter', value: 3 }, { name: 'meter', value: 4 }] }
            : e,
    )
    assert.deepEqual(parse(entities).report.entries, [
        { kind: 'field', archetype: '#BPM_CHANGE', field: 'meter', count: 1 },
    ])
})

test('a ref where a value is expected, or a value where a ref is, is reported', () => {
    const entities = [
        ...minimalLevel(),
        entity('NormalTapNote', { ...noteData(), elevation: ref('x') }),
    ]
    assert.deepEqual(parse(entities).report.entries, [
        { kind: 'field', archetype: 'NormalTapNote', field: 'elevation', count: 1 },
    ])
    const swapped = minimalLevel().map((e) =>
        e.archetype === 'Initialization'
            ? { ...e, data: [...e.data, { name: 'firstCamera', value: 1 }] }
            : e,
    )
    assert.deepEqual(parse(swapped).report.entries, [
        { kind: 'field', archetype: 'Initialization', field: 'firstCamera', count: 1 },
    ])
})

test('the table’s note archetypes are the parser’s, both ways', () => {
    assert.deepEqual([...tableNoteNames].sort(), [...noteArchetypeNames].sort())
    for (const archetype of tableNoteNames)
        assert.ok(isNoteEntity({ archetype, data: [] }), archetype)
    for (const archetype of Object.keys(knownArchetypes))
        assert.equal(isNoteEntity({ archetype, data: [] }), tableNoteNames.includes(archetype))
})

test('an ignored entry added with a version bump leaves the earlier tables as they were', () => {
    const archetypes = ignoredArchetypes as Record<string, Ignored>
    const fields = ignoredFields as Record<string, Record<string, Ignored>>
    const before = tableLevelVersion()
    archetypes.GuideSegment = { reason: 'rewritten', note: 'test', since: before + 1 }
    fields['#BPM_CHANGE'] = { swing: { reason: 'nothing', note: 'test', since: before + 1 } }
    resetAllowedFieldsForTests()
    try {
        assert.equal(tableLevelVersion(), before + 1)
        assert.deepEqual(tableAt(before), pinned[before])
        assert.ok(tableAt(before + 1).ignoredArchetypes.includes('GuideSegment'))
        // This build predates the entry, so it still reports it.
        const entities = minimalLevel().map((e) =>
            e.archetype === '#BPM_CHANGE'
                ? { ...e, data: [...e.data, { name: 'swing', value: 1 }] }
                : e,
        )
        const report = parse([...entities, entity('GuideSegment', {})]).report
        assert.deepEqual(report.entries.map((e) => e.kind).sort(), ['archetype', 'field'])
    } finally {
        delete archetypes.GuideSegment
        delete fields['#BPM_CHANGE']
        resetAllowedFieldsForTests()
    }
})

test('a refined schema is checked as Value.Check does, alone or in a choice', () => {
    const refined = Type.Refine(Type.Number(), (value) => value !== 3)
    const choice = Type.Union([
        Type.Literal(1),
        Type.Refine(Type.Literal(2), (value) => value !== 2),
    ])
    for (const schema of [refined, choice, Type.Union([refined, Type.Literal(5)])])
        for (const probe of [1, 2, 3, 4, 5, 'a'])
            assert.equal(check(schema, probe), Value.Check(schema, probe), `${probe}`)
})

test('every version tag on an ignored entry is a version that exists', () => {
    const tags = [
        ...Object.values(ignoredArchetypes),
        ...Object.values(ignoredFields).flatMap((fields) => Object.values(fields)),
    ].map(({ since }) => since ?? 1)
    for (const since of tags)
        assert.ok(Number.isInteger(since) && since >= 1 && since <= LEVEL_VERSION)
})

for (const [label, change, field] of [
    [
        'entity key',
        (e: LevelDataEntity) => Object.assign(e, { futureContent: { important: 42 } }),
        'entity.futureContent',
    ],
    [
        'data key',
        (e: LevelDataEntity) => Object.assign(e.data[0]!, { futureContent: { important: 43 } }),
        'data.initialLife.futureContent',
    ],
    [
        'value and ref',
        (e: LevelDataEntity) => Object.assign(e.data[0]!, { ref: 'unused' }),
        'data.initialLife.ref',
    ],
] as const)
    test(`unknown ${label} is reported without changing consumed values`, () => {
        const e: LevelDataEntity = {
            archetype: 'Initialization',
            data: [{ name: 'initialLife', value: 1000 }],
        }
        change(e)
        const report = new LevelDataReport()
        reportLevelDataEntities([e], report)
        assert.deepEqual(report.entries, [
            { kind: 'field', archetype: 'Initialization', field, count: 1 },
        ])
    })
