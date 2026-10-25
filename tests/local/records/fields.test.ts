import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { eases, timeScaleEaseFunctionNames } from '../../../src/ease'
import { canonical, type RecordValue } from '../../../src/local/records/canonical'
import { extractChart } from '../../../src/local/records/extract'
import fields from '../../../src/local/records/fields-v1.json'
import { headerRecord, kindEncoders } from '../../../src/local/records/records'
import { kindNames, type KindName } from '../../../src/local/records/schema'
import type { State } from '../../../src/state'
import { edgeChart, goldenChart, stateOf } from './charts'

// Positions checked independently of `toRecords`: every golden and edge record
// equals `fields.map(f => model[f.name] ?? f.default)` over its model object, so a swapped
// pair of positions fails here rather than freezing into v1.

type Entry = { name: string; type: string; optional?: boolean; default?: RecordValue }
const table = fields as unknown as Record<string, Entry[] | { type: string } | undefined>
const kinds = fields.kinds as Record<KindName, string>

const byTable = (name: string, model: unknown): RecordValue => {
    const form = table[name]
    if (!form) throw new Error(`No record ${name}`)
    if (!Array.isArray(form)) {
        const item = form.type.slice('array:'.length)
        return (model as unknown[]).map((value) => byTable(item, value))
    }
    const out: RecordValue[] = []
    for (const field of form) {
        const value = (model as Record<string, unknown>)[field.name] ?? field.default
        if (value === undefined && field.type === 'mediaRefOrEmpty') {
            out.push([])
            continue
        }
        if (value === undefined) {
            assert.ok(field.optional, `${name}.${field.name} is missing`)
            break
        }
        out.push(fieldValue(field.type, value))
    }
    return out
}

const fieldValue = (type: string, value: unknown): RecordValue => {
    if (type === 'mediaRefOrEmpty') return value ? byTable('mediaRef', value) : []
    if (type.startsWith('record:')) return byTable(type.slice('record:'.length), value)
    if (type.startsWith('array:')) {
        const item = type.slice('array:'.length)
        return (value as unknown[]).map((v) =>
            table[item] ? byTable(item, v) : (v as RecordValue),
        )
    }
    return value as RecordValue
}

const withIds = <V extends object>(map: ReadonlyMap<number, V>) =>
    [...map].map(([id, value]) => ({ id, ...value }))

const checkState = (state: State, label: string) => {
    const chart = extractChart(state)
    for (const kind of kindNames) {
        const encode = kindEncoders[kind] as (object: unknown) => RecordValue
        for (const object of chart[kind] as unknown[])
            assert.equal(
                canonical(byTable(kinds[kind], object)),
                canonical(encode(object)),
                `${label} ${kind}`,
            )
    }
    const header = {
        initialLife: chart.initialLife,
        isDynamicStages: chart.isDynamicStages,
        bgmOffset: state.bgm.offset,
        groups: withIds(chart.groups),
        stages: withIds(chart.stages),
        groupFolders: withIds(chart.groupFolders ?? new Map()),
        stageFolders: withIds(chart.stageFolders ?? new Map()),
        levelInfo: state.levelInfo,
        bgm: state.bgm.meta,
    }
    const extras = {
        bgmOffset: state.bgm.offset,
        levelInfo: state.levelInfo,
        ...(state.bgm.meta ? { bgm: state.bgm.meta } : {}),
    }
    assert.equal(
        canonical(byTable('header', header)),
        canonical(headerRecord(chart, extras)),
        `${label} header`,
    )
}

test('every golden and edge record matches fields-v1.json position by position', () => {
    checkState(stateOf(goldenChart()), 'golden')
    checkState(stateOf(edgeChart()), 'edge')
})

// The field tables, regenerated from
// fields-v1.json, so the two never disagree.
const planTables: Record<string, string[]> = {
    root: ['v', 'header', 'kinds', 'noteCount'],
    node: ['kind', 'depth', 'hashes'],
    header: [
        'initialLife',
        'isDynamicStages',
        'bgmOffset',
        'groups',
        'stages',
        'groupFolders',
        'stageFolders',
        'levelInfo',
        'bgm?',
    ],
    group: ['id', 'name', 'forceNoteSpeed', 'folderId?'],
    stage: ['id', 'name', 'isFromStart', 'isUntilEnd', 'generateSimLines', 'folderId?'],
    folder: ['id', 'name', 'index', 'folderId?'],
    levelInfo: ['title', 'artists', 'author', 'description', 'tags', 'cover', 'preview', 'rating?'],
    tag: ['title'],
    mediaRef: ['hash', 'filename', 'size', 'type'],
    bgm: ['hash', 'filename', 'size', 'type', 'durationMs?'],
    note: [
        'groupId',
        'stageId',
        'beat',
        'elevation',
        'noteStyle',
        'connectorStyle',
        'noteType',
        'isAttached',
        'left',
        'size',
        'isCritical',
        'flickDirection',
        'isFake',
        'sfx',
        'isConnectorSeparator',
        'connectorType',
        'connectorEase',
        'connectorIsFake',
        'connectorActiveIsCritical',
        'connectorGuideAlpha',
        'connectorLayer',
        'connectorIsPassThrough',
        'connectorPresentation',
    ],
    bpm: ['beat', 'bpm', 'meter'],
    timeScale: [
        'groupId',
        'beat',
        'editorLane',
        'timeScale',
        'skip',
        'timeScaleEase',
        'timeScaleTransition',
        'hideNotes',
    ],
    cameraEvent: [
        'beat',
        'cameraLeft',
        'cameraSize',
        'cameraZoom',
        'cameraZoomTargetLane',
        'cameraZoomTargetY',
        'cameraZoomVerticalAlign',
        'cameraRotation',
        'cameraStageTilt',
        'eventEase',
    ],
    stageMaskEvent: ['stageId', 'beat', 'maskLeft', 'maskSize', 'isMaskNotes', 'eventEase'],
    stagePivotEvent: [
        'stageId',
        'beat',
        'pivotLane',
        'divisionSize',
        'divisionParity',
        'yOffset',
        'yOffsetBeat',
        'eventEase',
    ],
    stageStyleEvent: [
        'stageId',
        'beat',
        'editorLane',
        'judgmentLineColor',
        'judgmentLineStyle',
        'leftBorderStyle',
        'rightBorderStyle',
        'isFullWidth',
        'noteAlpha',
        'laneAlpha',
        'judgmentLineAlpha',
        'divisionLineAlpha',
        'eventEase',
    ],
    stageTransformEvent: [
        'stageId',
        'beat',
        'rotation',
        'xTranslation',
        'yTranslation',
        'elevation',
        'anchor',
        'eventEase',
    ],
}

test('the field tables match fields-v1.json', () => {
    for (const [name, positions] of Object.entries(planTables)) {
        const form = table[name] as Entry[]
        assert.deepEqual(
            form.map((field) => `${field.name}${field.optional ? '?' : ''}`),
            positions,
            name,
        )
    }
    assert.deepEqual(Object.keys(fields.kinds), [...kindNames])
    assert.deepEqual(table.slide, { type: 'array:note', minItems: 1 })
    assert.deepEqual(table.kindRef, [
        { name: 'name', type: 'enum:kinds' },
        { name: 'hash', type: 'hash16' },
    ])
    assert.deepEqual((table.root as Entry[])[2], { name: 'kinds', type: 'array:kindRef' })
    assert.deepEqual((table.node as Entry[])[2], {
        name: 'hashes',
        type: 'array:hash16',
        minItems: 1,
    })
})

test('the ease value sets are the model’s', () => {
    assert.deepEqual(Object.keys(fields.enums.ease), eases)
    assert.deepEqual(
        Object.keys(fields.enums.timeScaleEase),
        eases.filter(
            (ease) =>
                ease === 'none' ||
                ease === 'linear' ||
                timeScaleEaseFunctionNames.some((name) => ease.toLowerCase().endsWith(name)),
        ),
    )
    for (const values of Object.values(fields.enums))
        for (const since of Object.values(values)) assert.equal(since, 1)
})

/** JSON parsed as a reader whose objects keep no key order (serde_json's `BTreeMap`) sees it. */
const parseSorted = (text: string): unknown =>
    JSON.parse(text, (_, value: unknown) =>
        value && typeof value === 'object' && !Array.isArray(value)
            ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)))
            : value,
    )

test('the kind order is the kindOrder array, which a reader with unordered objects reads too', () => {
    assert.deepEqual(fields.kindOrder, [...kindNames])
    const sorted = parseSorted(
        readFileSync(
            join(import.meta.dirname, '../../../src/local/records/fields-v1.json'),
            'utf8',
        ),
    ) as { kindOrder: string[]; kinds: Record<string, string>; enums: { kinds: object } }
    // Key order is lost, as in a Rust reader without `preserve_order`.
    assert.notDeepEqual(Object.keys(sorted.kinds), [...kindNames])
    assert.deepEqual(Object.keys(sorted.enums.kinds).sort(), Object.keys(sorted.kinds).sort())
    // A table-driven root check: `kinds` must follow `kindOrder`, no name twice.
    const inOrder = (names: string[]) =>
        names.every(
            (name, i) =>
                i === 0 ||
                sorted.kindOrder.indexOf(name) > sorted.kindOrder.indexOf(names[i - 1] ?? ''),
        )
    const golden = join(import.meta.dirname, 'golden-v1')
    const { root } = JSON.parse(readFileSync(join(golden, 'snapshot.json'), 'utf8')) as {
        root: string
    }
    const rootJson = JSON.parse(
        readFileSync(join(golden, 'records', `${root}.canonical`), 'utf8'),
    ) as [number, string, [string, string][], number]
    const names = rootJson[2].map(([name]) => name)
    assert.deepEqual(names.slice(0, 2), ['slides', 'bpms'])
    assert.ok(inOrder(names))
    assert.ok(!inOrder(['bpms', 'slides']))
    assert.ok(!inOrder(['slides', 'slides']))
})

test('the ids a record names are refs to their header maps', () => {
    const refs = Object.entries(table).flatMap(([name, form]) =>
        Array.isArray(form)
            ? form.flatMap((field) => {
                  const ref = (field as Entry & { ref?: string }).ref
                  return ref ? [`${name}.${field.name}→${ref}`] : []
              })
            : [],
    )
    assert.deepEqual(refs, [
        'group.folderId→groupFolders',
        'stage.folderId→stageFolders',
        'folder.folderId→folders',
        'note.groupId→groups',
        'note.stageId→stages',
        'timeScale.groupId→groups',
        'stageMaskEvent.stageId→stages',
        'stagePivotEvent.stageId→stages',
        'stageStyleEvent.stageId→stages',
        'stageTransformEvent.stageId→stages',
    ])
    const acyclic = Object.entries(table).flatMap(([name, form]) =>
        Array.isArray(form)
            ? form
                  .filter((field) => (field as Entry & { acyclic?: boolean }).acyclic)
                  .map((field) => `${name}.${field.name}`)
            : [],
    )
    assert.deepEqual(acyclic, ['folder.folderId'])
})
