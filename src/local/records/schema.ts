import type { BpmObject } from '../../chart/bpm'
import type { CameraEventObject, CameraZoomVerticalAlign } from '../../chart/events/camera'
import type { StageMaskEventObject } from '../../chart/events/stage/mask'
import type { DivisionParity, StagePivotEventObject } from '../../chart/events/stage/pivot'
import type {
    BorderStyle,
    JudgmentLineColor,
    JudgmentLineStyle,
    StageStyleEventObject,
} from '../../chart/events/stage/style'
import type { Anchor, StageTransformEventObject } from '../../chart/events/stage/transform'
import type { FolderObject } from '../../chart/folders'
import type { GroupObject } from '../../chart/groups'
import type {
    ConnectorLayer,
    ConnectorPresentation,
    ConnectorType,
    FlickDirection,
    NoteObject,
    NoteSfx,
    NoteType,
} from '../../chart/note'
import type { NoteStyle } from '../../chart/noteStyle'
import type { GenerateSimLines, StageObject } from '../../chart/stages'
import type { TimeScaleObject, TimeScaleTransition } from '../../chart/timeScale'
import type { Ease, TimeScaleEase } from '../../ease'
import type { BgmMeta } from '../../state/bgm'
import type { LevelInfo, LevelInfoTag, MediaRef } from '../../state/levelInfo'
import { isHash16Hex } from '../hash'
import type { RecordValue } from './canonical'

// The one schema source for snapshot records: record forms, field order, JSON
// types, defaults and choice value sets. `npm run format:gen` writes `fields-v1.json` from
// it, and a test fails when that file drifts. Adding a field is one change here, at the end
// of its record, optional, with a `format:bump`.

/**
 * The v1 kind order, one per array of the chart model. `fields-v1.json` carries it as the
 * `kindOrder` array: JSON object key order means nothing, so no reader takes it from `kinds`.
 */
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

/**
 * The header map an id must name: `folders` is the folder map holding the
 * record itself. A snapshot whose records name an id its header lacks is invalid.
 */
export type RefTarget = 'groups' | 'stages' | 'groupFolders' | 'stageFolders' | 'folders'

export type Field<N extends string = string> = {
    readonly name: N
    readonly type: FieldType
    /** An `id` that must name an entry of this header map. */
    readonly ref?: RefTarget
    /** A `ref` within its own map whose links never loop: no record is its own ancestor. */
    readonly acyclic?: true
    /** Only trailing fields; an unset one is left off. */
    readonly optional?: true
    readonly minItems?: number
    /** What `toRecords` writes when the model leaves the field out. */
    readonly default?: RecordValue
}

/** A positional record, or a record that is itself an array (a slide is its notes). */
export type RecordForm =
    readonly Field[] | { readonly type: `array:${string}`; readonly minItems?: number }

const f = <N extends string>(
    name: N,
    type: FieldType,
    extra: Omit<Field, 'name' | 'type'> = {},
): Field<N> => ({ name, type, ...extra })
const optional = { optional: true } as const
const folderLink = (ref: RefTarget) => ({ optional: true, ref }) as const

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
        f('folderId', 'id', folderLink('groupFolders')),
    ],
    stage: [
        f('id', 'id'),
        f('name', 'string'),
        f('isFromStart', 'bool'),
        f('isUntilEnd', 'bool'),
        f('generateSimLines', 'enum:generateSimLines'),
        f('folderId', 'id', folderLink('stageFolders')),
    ],
    folder: [
        f('id', 'id'),
        f('name', 'string'),
        f('index', 'uint'),
        f('folderId', 'id', { ...folderLink('folders'), acyclic: true }),
    ],
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
    tag: [f('title', 'string')],
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
        f('groupId', 'id', { ref: 'groups' }),
        f('stageId', 'id', { ref: 'stages' }),
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
        f('groupId', 'id', { ref: 'groups' }),
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
        f('stageId', 'id', { ref: 'stages' }),
        f('beat', 'number'),
        f('maskLeft', 'number'),
        f('maskSize', 'number'),
        f('isMaskNotes', 'bool'),
        f('eventEase', 'enum:ease'),
    ],
    stagePivotEvent: [
        f('stageId', 'id', { ref: 'stages' }),
        f('beat', 'number'),
        f('pivotLane', 'number'),
        f('divisionSize', 'number'),
        f('divisionParity', 'enum:divisionParity'),
        f('yOffset', 'number'),
        f('yOffsetBeat', 'number'),
        f('eventEase', 'enum:ease'),
    ],
    stageStyleEvent: [
        f('stageId', 'id', { ref: 'stages' }),
        f('beat', 'number'),
        f('editorLane', 'number'),
        f('laneColor', 'enum:noteStyle'),
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
        f('stageId', 'id', { ref: 'stages' }),
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

// Each model record's fields must equal its form's names, both ways, so a model field added
// later can't be left out of history silently: a type here names what differs.
type Names<N extends RecordName> = (typeof records)[N] extends readonly Field<infer F>[] ? F : never
export const fieldsMatchModel: [
    Same<Names<'note'>, keyof NoteObject>,
    Same<Names<'bpm'>, keyof BpmObject>,
    Same<Names<'timeScale'>, keyof TimeScaleObject>,
    Same<Names<'cameraEvent'>, keyof CameraEventObject>,
    Same<Names<'stageMaskEvent'>, keyof StageMaskEventObject>,
    Same<Names<'stagePivotEvent'>, keyof StagePivotEventObject>,
    Same<Names<'stageStyleEvent'>, keyof StageStyleEventObject>,
    Same<Names<'stageTransformEvent'>, keyof StageTransformEventObject>,
    Same<Names<'group'>, 'id' | keyof GroupObject>,
    Same<Names<'stage'>, 'id' | keyof StageObject>,
    Same<Names<'folder'>, 'id' | keyof FolderObject>,
    Same<Names<'levelInfo'>, keyof LevelInfo>,
    Same<Names<'tag'>, keyof LevelInfoTag>,
    Same<Names<'mediaRef'>, keyof MediaRef>,
    Same<Names<'bgm'>, keyof BgmMeta>,
] = [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true]

/** A record that breaks the v1 schema: unreadable history, a damaged snapshot. */
export class SchemaError extends Error {
    override name = 'SchemaError'
    constructor(
        readonly path: string,
        message: string,
    ) {
        super(`${path}: ${message}`)
    }
}

// `id` and `uint` are judged by value, as `JSON.parse` reads them: `1`, `1.0` and `1e0` are one
// id, and `-0` is the `uint` 0 (never an id). The writer spells an integer only as plain digits
// (`Number::toString`), so bytes spelled otherwise hash differently: such a chunk reads under its
// own hash (a hand-made file), never under the canonical bytes' hash.
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
 * Checks a record's arity and JSON types against its form: positions, optional
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

/** The ids a header's maps define, for the references records make. */
export type HeaderIds = Readonly<Record<Exclude<RefTarget, 'folders'>, ReadonlySet<unknown>>>

const idsOf = (records: RecordValue | undefined) =>
    new Set((records as readonly RecordValue[][]).map((record) => record[0]))

export const headerIds = (header: readonly RecordValue[]): HeaderIds => ({
    groups: idsOf(header[3]),
    stages: idsOf(header[4]),
    groupFolders: idsOf(header[5]),
    stageFolders: idsOf(header[6]),
})

/**
 * Checks that every `ref` field of a record that passed `checkRecord` names an id of its map
 *: a note's group and stage, a time scale's group, a stage event's stage, and the folder
 * links of groups, stages and folders. `folders` is the map holding a folder record.
 */
export const checkRefs = (
    name: RecordName,
    value: unknown,
    ids: HeaderIds,
    path: string = name,
    folders?: ReadonlySet<unknown>,
): void => {
    const form: RecordForm = records[name]
    if (!Array.isArray(form)) {
        const item = splitType((form as { type: string }).type)[1] as RecordName
        for (const [i, record] of (value as unknown[]).entries())
            checkRefs(item, record, ids, `${path}[${i}]`, folders)
        return
    }
    const fields = form as readonly Field[]
    const list = value as readonly unknown[]
    for (let i = 0; i < list.length; i++) {
        const field = fields[i]
        if (!field) continue
        const at = `${path}.${field.name}`
        if (field.ref) {
            const target = field.ref === 'folders' ? folders : ids[field.ref]
            if (!target?.has(list[i]))
                throw new SchemaError(at, `no ${field.ref} entry ${String(list[i])}`)
            continue
        }
        const [kind, item = ''] = splitType(field.type)
        if (kind === 'record') checkRefs(item as RecordName, list[i], ids, at)
        else if (kind === 'array' && Object.hasOwn(records, item)) {
            // A folder map is the map its folders' own links name.
            const holder =
                field.name === 'groupFolders' || field.name === 'stageFolders'
                    ? ids[field.name]
                    : folders
            for (const [j, record] of (list[i] as unknown[]).entries())
                checkRefs(item as RecordName, record, ids, `${at}[${j}]`, holder)
        }
    }
}

/** Checks that a folder map's parent links never loop, a folder its own parent included. */
const checkAcyclic = (folders: readonly RecordValue[][], path: string) => {
    const at = (records.folder as readonly Field[]).findIndex((field) => field.acyclic)
    // Ids and links are safe integers once the form and refs are checked.
    const parents = new Map(folders.map((folder) => [folder[0] as number, folder[at] as number]))
    for (const [i, folder] of folders.entries()) {
        const seen = new Set<number>()
        for (
            let id: number | undefined = folder[0] as number;
            id !== undefined;
            id = parents.get(id)
        ) {
            if (seen.has(id)) throw new SchemaError(`${path}[${i}].folderId`, `folder ${id} loops`)
            seen.add(id)
        }
    }
}

/** A header chunk, checked whole: its form, the id rules, then its own folder links. */
export const checkHeader = (value: unknown) => {
    checkRecord('header', value)
    const header = value as RecordValue[]
    checkHeaderIds(header)
    checkRefs('header', header, headerIds(header))
    checkAcyclic(header[5] as RecordValue[][], 'header.groupFolders')
    checkAcyclic(header[6] as RecordValue[][], 'header.stageFolders')
}
