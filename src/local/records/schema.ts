import type { CameraZoomVerticalAlign } from '../../chart/events/camera'
import type { DivisionParity } from '../../chart/events/stage/pivot'
import type {
    BorderStyle,
    JudgmentLineColor,
    JudgmentLineStyle,
} from '../../chart/events/stage/style'
import type { Anchor } from '../../chart/events/stage/transform'
import type {
    ConnectorLayer,
    ConnectorPresentation,
    ConnectorType,
    FlickDirection,
    NoteSfx,
    NoteType,
} from '../../chart/note'
import type { NoteStyle } from '../../chart/noteStyle'
import type { GenerateSimLines } from '../../chart/stages'
import type { TimeScaleTransition } from '../../chart/timeScale'
import type { Ease, TimeScaleEase } from '../../ease'
import { isHash16Hex } from '../hash'
import type { RecordValue } from './canonical'

// The one schema source for snapshot records (§1.6.11.1): record forms, field order, JSON
// types, defaults and choice value sets. `npm run format:gen` writes `fields-v1.json` from
// it, and a test fails when that file drifts. Adding a field is one change here, at the end
// of its record, optional, with a `format:bump` (Part 4, 4.9.4).

/** The v1 kind order, one per array of the chart model. */
export const kindNames = [
    'slides',
    'bpms',
    'timeScales',
    'cameraEvents',
    'stageMaskEvents',
    'stagePivotEvents',
    'stageStyleEvents',
    'stageTransformEvents',
] as const

export type KindName = (typeof kindNames)[number]

const easeFunctions = [
    'Sine',
    'Quad',
    'Cubic',
    'Quart',
    'Quint',
    'Expo',
    'Circ',
    'Back',
    'Elastic',
    'Step',
] as const
const easeModes = ['in', 'out', 'inOut', 'outIn'] as const
const easeList = [
    'none',
    'linear',
    ...easeFunctions.flatMap((name) => easeModes.map((mode) => `${mode}${name}`)),
] as Ease[]

/** Each choice set's values, by the `levelVersion` that added them. */
const choices = {
    kinds: kindNames,
    noteStyle: ['default', 'neutral', 'red', 'green', 'blue', 'yellow', 'purple', 'cyan', 'black'],
    noteType: ['default', 'trace', 'anchor', 'damage', 'forceTick', 'forceNonTick'],
    flickDirection: ['none', 'up', 'upLeft', 'upRight', 'down', 'downLeft', 'downRight'],
    sfx: [
        'default',
        'none',
        'normalTap',
        'criticalTap',
        'normalFlick',
        'criticalFlick',
        'normalTrace',
        'criticalTrace',
        'normalTick',
        'criticalTick',
        'damage',
    ],
    connectorType: ['active', 'guide', 'damage'],
    ease: easeList,
    timeScaleEase: easeList.filter((ease) => !/(Back|Elastic)$/.test(ease)),
    connectorLayer: ['top', 'bottom', 'under', 'over'],
    connectorPresentation: ['default', 'fullscreen'],
    timeScaleTransition: ['timeScale', 'scroll'],
    cameraZoomVerticalAlign: ['default', 'center'],
    divisionParity: ['even', 'odd'],
    judgmentLineColor: ['neutral', 'red', 'green', 'blue', 'yellow', 'purple', 'cyan', 'black'],
    judgmentLineStyle: ['default', 'singleLine'],
    borderStyle: ['default', 'light', 'medium', 'disabled'],
    anchor: ['default', 'center'],
    generateSimLines: ['global', 'isolated'],
} as const satisfies Record<string, readonly string[]>

export type EnumName = keyof typeof choices

/** Values a later `levelVersion` added; every other value is from 1. */
const addedLater: Partial<Record<EnumName, Readonly<Record<string, number>>>> = {}

/** Each choice set, value → the `levelVersion` that added it, in the model's order. */
export const enums = Object.fromEntries(
    Object.entries(choices).map(([name, values]) => [
        name,
        Object.fromEntries(
            values.map((value) => [value, addedLater[name as EnumName]?.[value] ?? 1]),
        ),
    ]),
) as Record<EnumName, Readonly<Record<string, number>>>

// Each set must equal the model's union, both ways: a type here names what differs.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : A | B) : A | B
type ChoiceOf<N extends EnumName> = (typeof choices)[N][number]
export const enumsMatchModel: [
    Same<ChoiceOf<'noteStyle'>, NoteStyle>,
    Same<ChoiceOf<'noteType'>, NoteType>,
    Same<ChoiceOf<'flickDirection'>, FlickDirection>,
    Same<ChoiceOf<'sfx'>, NoteSfx>,
    Same<ChoiceOf<'connectorType'>, ConnectorType>,
    Same<ChoiceOf<'connectorLayer'>, ConnectorLayer>,
    Same<ChoiceOf<'connectorPresentation'>, ConnectorPresentation>,
    Same<ChoiceOf<'timeScaleTransition'>, TimeScaleTransition>,
    Same<ChoiceOf<'cameraZoomVerticalAlign'>, CameraZoomVerticalAlign>,
    Same<ChoiceOf<'divisionParity'>, DivisionParity>,
    Same<ChoiceOf<'judgmentLineColor'>, JudgmentLineColor>,
    Same<ChoiceOf<'judgmentLineStyle'>, JudgmentLineStyle>,
    Same<ChoiceOf<'borderStyle'>, BorderStyle>,
    Same<ChoiceOf<'anchor'>, Anchor>,
    Same<ChoiceOf<'generateSimLines'>, GenerateSimLines>,
] = [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true]

/** Eases are built above, so a test checks them against `ease.ts` and `TimeScaleEase`. */
export type EaseSets = { ease: Ease; timeScaleEase: TimeScaleEase }

export type FieldType =
    | 'id'
    | 'uint'
    | 'number'
    | 'bool'
    | 'string'
    | 'hash16'
    | 'mediaRefOrEmpty'
    | `enum:${EnumName}`
    | `array:${string}`
    | `record:${string}`

export type Field = {
    readonly name: string
    readonly type: FieldType
    /** Only trailing fields; an unset one is left off. */
    readonly optional?: true
    readonly minItems?: number
    /** What `toRecords` writes when the model leaves the field out. */
    readonly default?: RecordValue
}

/** A positional record, or a record that is itself an array (a slide is its notes). */
export type RecordForm =
    readonly Field[] | { readonly type: `array:${string}`; readonly minItems?: number }

const f = (name: string, type: FieldType, extra: Omit<Field, 'name' | 'type'> = {}): Field => ({
    name,
    type,
    ...extra,
})
const optional = { optional: true } as const

/** Every v1 record form, by name. Positions are pinned once v0.6.0 ships. */
export const records = {
    root: [
        f('v', 'uint'),
        f('header', 'hash16'),
        f('kinds', 'array:kindRef'),
        f('noteCount', 'uint'),
    ],
    kindRef: [f('name', 'enum:kinds'), f('hash', 'hash16')],
    node: [
        f('kind', 'enum:kinds'),
        f('depth', 'uint'),
        f('hashes', 'array:hash16', { minItems: 1 }),
    ],
    header: [
        f('initialLife', 'number'),
        f('isDynamicStages', 'bool'),
        f('bgmOffset', 'number'),
        f('groups', 'array:group'),
        f('stages', 'array:stage'),
        f('groupFolders', 'array:folder'),
        f('stageFolders', 'array:folder'),
        f('levelInfo', 'record:levelInfo'),
        f('bgm', 'record:bgm', optional),
    ],
    group: [
        f('id', 'id'),
        f('name', 'string'),
        f('forceNoteSpeed', 'number', { default: 0 }),
        f('folderId', 'id', optional),
    ],
    stage: [
        f('id', 'id'),
        f('name', 'string'),
        f('isFromStart', 'bool'),
        f('isUntilEnd', 'bool'),
        f('generateSimLines', 'enum:generateSimLines'),
        f('folderId', 'id', optional),
    ],
    folder: [f('id', 'id'), f('name', 'string'), f('index', 'uint'), f('folderId', 'id', optional)],
    levelInfo: [
        f('title', 'string'),
        f('artists', 'string'),
        f('author', 'string'),
        f('description', 'string'),
        f('tags', 'array:tag'),
        f('cover', 'mediaRefOrEmpty'),
        f('preview', 'mediaRefOrEmpty'),
        f('rating', 'number', optional),
    ],
    tag: [f('title', 'string'), f('icon', 'string', optional)],
    mediaRef: [
        f('hash', 'hash16'),
        f('filename', 'string'),
        f('size', 'uint'),
        f('type', 'string'),
    ],
    bgm: [
        f('hash', 'hash16'),
        f('filename', 'string'),
        f('size', 'uint'),
        f('type', 'string'),
        f('durationMs', 'uint', optional),
    ],
    slide: { type: 'array:note', minItems: 1 },
    note: [
        f('groupId', 'id'),
        f('stageId', 'id'),
        f('beat', 'number'),
        f('elevation', 'number', { default: 0 }),
        f('noteStyle', 'enum:noteStyle'),
        f('connectorStyle', 'enum:noteStyle'),
        f('noteType', 'enum:noteType'),
        f('isAttached', 'bool'),
        f('left', 'number'),
        f('size', 'number'),
        f('isCritical', 'bool'),
        f('flickDirection', 'enum:flickDirection'),
        f('isFake', 'bool'),
        f('sfx', 'enum:sfx'),
        f('isConnectorSeparator', 'bool'),
        f('connectorType', 'enum:connectorType'),
        f('connectorEase', 'enum:ease'),
        f('connectorIsFake', 'bool'),
        f('connectorActiveIsCritical', 'bool'),
        f('connectorGuideAlpha', 'number'),
        f('connectorLayer', 'enum:connectorLayer'),
        f('connectorIsPassThrough', 'bool'),
        f('connectorPresentation', 'enum:connectorPresentation'),
    ],
    bpm: [f('beat', 'number'), f('bpm', 'number'), f('meter', 'number', { default: 4 })],
    timeScale: [
        f('groupId', 'id'),
        f('beat', 'number'),
        f('editorLane', 'number'),
        f('timeScale', 'number'),
        f('skip', 'number'),
        f('timeScaleEase', 'enum:timeScaleEase'),
        f('timeScaleTransition', 'enum:timeScaleTransition'),
        f('hideNotes', 'bool'),
    ],
    cameraEvent: [
        f('beat', 'number'),
        f('cameraLeft', 'number'),
        f('cameraSize', 'number'),
        f('cameraZoom', 'number'),
        f('cameraZoomTargetLane', 'number'),
        f('cameraZoomTargetY', 'number'),
        f('cameraZoomVerticalAlign', 'enum:cameraZoomVerticalAlign'),
        f('cameraRotation', 'number'),
        f('cameraStageTilt', 'number'),
        f('eventEase', 'enum:ease'),
    ],
    stageMaskEvent: [
        f('stageId', 'id'),
        f('beat', 'number'),
        f('maskLeft', 'number'),
        f('maskSize', 'number'),
        f('isMaskNotes', 'bool'),
        f('eventEase', 'enum:ease'),
    ],
    stagePivotEvent: [
        f('stageId', 'id'),
        f('beat', 'number'),
        f('pivotLane', 'number'),
        f('divisionSize', 'number'),
        f('divisionParity', 'enum:divisionParity'),
        f('yOffset', 'number'),
        f('yOffsetBeat', 'number'),
        f('eventEase', 'enum:ease'),
    ],
    stageStyleEvent: [
        f('stageId', 'id'),
        f('beat', 'number'),
        f('editorLane', 'number'),
        f('judgmentLineColor', 'enum:judgmentLineColor'),
        f('judgmentLineStyle', 'enum:judgmentLineStyle'),
        f('leftBorderStyle', 'enum:borderStyle'),
        f('rightBorderStyle', 'enum:borderStyle'),
        f('isFullWidth', 'bool'),
        f('noteAlpha', 'number'),
        f('laneAlpha', 'number'),
        f('judgmentLineAlpha', 'number'),
        f('divisionLineAlpha', 'number'),
        f('eventEase', 'enum:ease'),
    ],
    stageTransformEvent: [
        f('stageId', 'id'),
        f('beat', 'number'),
        f('rotation', 'number'),
        f('xTranslation', 'number'),
        f('yTranslation', 'number'),
        f('elevation', 'number'),
        f('anchor', 'enum:anchor'),
        f('eventEase', 'enum:ease'),
    ],
} as const satisfies Record<string, RecordForm>

export type RecordName = keyof typeof records

/** The record form of each kind's body records. */
export const kindRecords = {
    slides: 'slide',
    bpms: 'bpm',
    timeScales: 'timeScale',
    cameraEvents: 'cameraEvent',
    stageMaskEvents: 'stageMaskEvent',
    stagePivotEvents: 'stagePivotEvent',
    stageStyleEvents: 'stageStyleEvent',
    stageTransformEvents: 'stageTransformEvent',
} as const satisfies Record<KindName, RecordName>

/** A record that breaks the v1 schema (§1.6.11.1): unreadable history, a damaged snapshot. */
export class SchemaError extends Error {
    override name = 'SchemaError'
    constructor(
        readonly path: string,
        message: string,
    ) {
        super(`${path}: ${message}`)
    }
}

const isId = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0
const isUint = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0

/** The scalar types, each with what it expects. */
const scalars: Record<string, [check: (value: unknown) => boolean, expected: string] | undefined> =
    {
        id: [isId, 'a positive safe integer'],
        uint: [isUint, 'a non-negative safe integer'],
        number: [(value) => typeof value === 'number' && Number.isFinite(value), 'a finite number'],
        bool: [(value) => typeof value === 'boolean', 'a boolean'],
        string: [(value) => typeof value === 'string', 'a string'],
        hash16: [isHash16Hex, '32 lowercase hex characters'],
    }

const checkType = (type: FieldType, value: unknown, path: string): void => {
    const fail = (expected: string) => {
        throw new SchemaError(
            path,
            `expected ${expected}, got ${(JSON.stringify(value) as string | undefined) ?? String(value)}`,
        )
    }
    const scalar = scalars[type]
    if (scalar) {
        if (!scalar[0](value)) fail(scalar[1])
        return
    }
    if (type === 'mediaRefOrEmpty') {
        if (!Array.isArray(value) || value.length) checkRecord('mediaRef', value, path)
        return
    }
    const [kind, name = ''] = splitType(type)
    if (kind === 'enum') {
        const values = enums[name as EnumName] as Readonly<Record<string, number>> | undefined
        if (!values) throw new Error(`Unexpected enum ${name}`)
        if (typeof value !== 'string' || !Object.hasOwn(values, value)) fail(`a value of ${name}`)
    } else if (kind === 'array') {
        if (!Array.isArray(value)) fail('an array')
        const items = value as unknown[]
        for (let i = 0; i < items.length; i++) checkItem(name, items[i], `${path}[${i}]`)
    } else if (kind === 'record') {
        checkRecord(name as RecordName, value, path)
    } else {
        throw new Error(`Unexpected type ${type}`)
    }
}

const splitType = (type: string) => {
    const at = type.indexOf(':')
    return at < 0 ? [type] : [type.slice(0, at), type.slice(at + 1)]
}

/** An array item: a record by name, or a scalar type. */
const checkItem = (type: string, value: unknown, path: string) => {
    if (Object.hasOwn(records, type)) checkRecord(type as RecordName, value, path)
    else checkType(type as FieldType, value, path)
}

const checkMinItems = (minItems: number | undefined, value: unknown, path: string) => {
    if (minItems !== undefined && (value as unknown[]).length < minItems)
        throw new SchemaError(path, `expected at least ${minItems} items`)
}

/**
 * Checks a record's arity and JSON types against its form (§1.6.11.1): positions, optional
 * fields only trailing, enum membership, nested records. Ranges are the editor's, not the format's.
 */
export const checkRecord = (name: RecordName, value: unknown, path: string = name): void => {
    const form: RecordForm = records[name]
    if (!Array.isArray(value)) throw new SchemaError(path, 'expected an array')
    if (!Array.isArray(form)) {
        const array = form as Exclude<RecordForm, readonly Field[]>
        checkType(array.type, value, path)
        checkMinItems(array.minItems, value, path)
        return
    }
    const fields = form as readonly Field[]
    const required = fields.filter((field) => !field.optional).length
    if (value.length < required || value.length > fields.length)
        throw new SchemaError(
            path,
            `expected ${required}–${fields.length} positions, got ${value.length}`,
        )
    for (let i = 0; i < value.length; i++) {
        if (!(i in value)) throw new SchemaError(path, `hole at ${i}`)
        const field = fields[i]
        if (!field) throw new SchemaError(path, `extra position ${i}`)
        const at = `${path}.${field.name}`
        checkType(field.type, value[i], at)
        checkMinItems(field.minItems, value[i], at)
    }
}

/** A header's id rules beyond types: unique within each map, folders unique across both. */
export const checkHeaderIds = (header: readonly RecordValue[]) => {
    const unique = (records: unknown, path: string, seen = new Set<unknown>()) => {
        for (const [i, record] of (records as RecordValue[][]).entries()) {
            const id = record[0]
            if (seen.has(id))
                throw new SchemaError(`${path}[${i}].id`, `duplicate id ${String(id)}`)
            seen.add(id)
        }
        return seen
    }
    unique(header[3], 'header.groups')
    unique(header[4], 'header.stages')
    unique(header[6], 'header.stageFolders', unique(header[5], 'header.groupFolders'))
}

/** A header chunk, checked whole: its form, then the id rules. */
export const checkHeader = (value: unknown) => {
    checkRecord('header', value)
    checkHeaderIds(value as RecordValue[])
}
