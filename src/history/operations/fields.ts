import { eases, timeScaleEaseFunctionNames, type TimeScaleEase } from '../../ease'
import { toWellFormed } from '../../local/records/wellFormed'
import type { EditableProperties } from '../../state/operations/editable'
import {
    boolean,
    codec,
    count,
    finite,
    literal,
    object,
    oneOf,
    positive,
    refine,
    type ValueOf,
} from './codec'
import { isJsonText, isObject, owns } from './json'

export const NAME_CODE_POINTS = 256
export const FALLBACK_CODE_POINTS = 1024

export type NameText = { readonly text: string; readonly truncated?: true }

export const excerpt = (value: string, limit: number) => {
    if (typeof value !== 'string' || !Number.isSafeInteger(limit) || limit < 0)
        throw new TypeError('Invalid text excerpt')
    const points: string[] = []
    for (const point of value) {
        if (points.length === limit) return { text: points.join(''), truncated: true }
        points.push(toWellFormed(point))
    }
    return { text: points.join(''), truncated: false }
}

export const captureName = (value: string): NameText => {
    const { text, truncated } = excerpt(value, NAME_CODE_POINTS)
    return Object.freeze({ text, ...(truncated ? { truncated: true as const } : {}) })
}

export const nameText = object(
    {
        text: codec<string>(
            (value) => isJsonText(value) && !excerpt(value, NAME_CODE_POINTS).truncated,
        ),
    },
    { truncated: literal(true) },
)

export const nativeKinds = [
    'note',
    'bpm',
    'timeScale',
    'cameraEvent',
    'stageMaskEvent',
    'stagePivotEvent',
    'stageStyleEvent',
    'stageTransformEvent',
] as const
export type NativeKind = (typeof nativeKinds)[number]
export const nativeKind = oneOf(nativeKinds)
export const subjects = [...nativeKinds, 'objects'] as const
export type Subject = (typeof subjects)[number]
export const subject = oneOf(subjects)

export const ownerKinds = ['group', 'stage', 'groupFolder', 'stageFolder'] as const
export type OwnerKind = (typeof ownerKinds)[number]
export const ownerKind = oneOf(ownerKinds)
export const ownerReference = object({ kind: ownerKind, id: count, name: nameText })
export type OwnerReference = ValueOf<typeof ownerReference>
export const groupReference = object({ kind: literal('group'), id: count, name: nameText })
export const stageReference = object({ kind: literal('stage'), id: count, name: nameText })

const colors = ['neutral', 'red', 'green', 'blue', 'yellow', 'purple', 'cyan', 'black'] as const
const styles = oneOf(['default', ...colors])
const ease = oneOf(eases)
const timeScaleEase = codec<TimeScaleEase>(
    (value) =>
        ease.is(value) &&
        (value === 'none' ||
            value === 'linear' ||
            timeScaleEaseFunctionNames.some((name) => value.toLowerCase().endsWith(name))),
)

export const fieldCodecs = {
    beat: finite,
    editorLane: finite,
    left: finite,
    size: finite,
    cameraLeft: finite,
    cameraSize: finite,
    maskLeft: finite,
    maskSize: finite,
    pivotLane: finite,
    xTranslation: finite,
    yTranslation: finite,
    bpm: finite,
    meter: finite,
    timeScale: finite,
    skip: finite,
    timeScaleEase,
    timeScaleTransition: oneOf(['timeScale', 'scroll']),
    hideNotes: boolean,
    cameraZoom: finite,
    cameraZoomTargetLane: finite,
    cameraZoomTargetY: finite,
    cameraZoomVerticalAlign: oneOf(['default', 'center']),
    cameraRotation: finite,
    cameraStageTilt: finite,
    isMaskNotes: boolean,
    divisionSize: finite,
    divisionParity: oneOf(['even', 'odd']),
    yOffset: finite,
    yOffsetBeat: finite,
    judgmentLineColor: oneOf(colors),
    judgmentLineStyle: oneOf(['default', 'singleLine']),
    leftBorderStyle: oneOf(['default', 'light', 'medium', 'disabled']),
    rightBorderStyle: oneOf(['default', 'light', 'medium', 'disabled']),
    isFullWidth: boolean,
    noteAlpha: finite,
    laneAlpha: finite,
    judgmentLineAlpha: finite,
    divisionLineAlpha: finite,
    rotation: finite,
    anchor: oneOf(['default', 'center']),
    eventEase: ease,
    noteType: oneOf(['default', 'trace', 'anchor', 'damage', 'forceTick', 'forceNonTick']),
    isCritical: boolean,
    flickDirection: oneOf(['none', 'up', 'upLeft', 'upRight', 'down', 'downLeft', 'downRight']),
    isAttached: boolean,
    noteStyle: styles,
    isFake: boolean,
    sfx: oneOf([
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
    ]),
    isConnectorSeparator: boolean,
    connectorType: oneOf(['active', 'guide', 'damage']),
    connectorStyle: styles,
    connectorEase: ease,
    connectorIsFake: boolean,
    connectorActiveIsCritical: boolean,
    connectorGuideAlpha: finite,
    connectorLayer: oneOf(['top', 'bottom', 'under', 'over']),
    connectorIsPassThrough: boolean,
    connectorPresentation: oneOf(['default', 'fullscreen']),
    groupId: groupReference,
    stageId: stageReference,
    elevation: finite,
} as const satisfies Record<keyof EditableProperties, unknown>

export type FieldId = keyof typeof fieldCodecs
export type FieldValue<F extends FieldId> = ValueOf<(typeof fieldCodecs)[F]>

const events = [
    'cameraEvent',
    'stageMaskEvent',
    'stagePivotEvent',
    'stageStyleEvent',
    'stageTransformEvent',
] as const
const stages = [
    'stageMaskEvent',
    'stagePivotEvent',
    'stageStyleEvent',
    'stageTransformEvent',
] as const

export const fieldSubjects = {
    beat: nativeKinds,
    editorLane: ['timeScale', 'stageStyleEvent'],
    left: ['note'],
    size: ['note'],
    cameraLeft: ['cameraEvent'],
    cameraSize: ['cameraEvent'],
    maskLeft: ['stageMaskEvent'],
    maskSize: ['stageMaskEvent'],
    pivotLane: ['stagePivotEvent'],
    xTranslation: ['stageTransformEvent'],
    yTranslation: ['stageTransformEvent'],
    bpm: ['bpm'],
    meter: ['bpm'],
    timeScale: ['timeScale'],
    skip: ['timeScale'],
    timeScaleEase: ['timeScale'],
    timeScaleTransition: ['timeScale'],
    hideNotes: ['timeScale'],
    cameraZoom: ['cameraEvent'],
    cameraZoomTargetLane: ['cameraEvent'],
    cameraZoomTargetY: ['cameraEvent'],
    cameraZoomVerticalAlign: ['cameraEvent'],
    cameraRotation: ['cameraEvent'],
    cameraStageTilt: ['cameraEvent'],
    isMaskNotes: ['stageMaskEvent'],
    divisionSize: ['stagePivotEvent'],
    divisionParity: ['stagePivotEvent'],
    yOffset: ['stagePivotEvent'],
    yOffsetBeat: ['stagePivotEvent'],
    judgmentLineColor: ['stageStyleEvent'],
    judgmentLineStyle: ['stageStyleEvent'],
    leftBorderStyle: ['stageStyleEvent'],
    rightBorderStyle: ['stageStyleEvent'],
    isFullWidth: ['stageStyleEvent'],
    noteAlpha: ['stageStyleEvent'],
    laneAlpha: ['stageStyleEvent'],
    judgmentLineAlpha: ['stageStyleEvent'],
    divisionLineAlpha: ['stageStyleEvent'],
    rotation: ['stageTransformEvent'],
    anchor: ['stageTransformEvent'],
    eventEase: events,
    noteType: ['note'],
    isCritical: ['note'],
    flickDirection: ['note'],
    isAttached: ['note'],
    noteStyle: ['note'],
    isFake: ['note'],
    sfx: ['note'],
    isConnectorSeparator: ['note'],
    connectorType: ['note'],
    connectorStyle: ['note'],
    connectorEase: ['note'],
    connectorIsFake: ['note'],
    connectorActiveIsCritical: ['note'],
    connectorGuideAlpha: ['note'],
    connectorLayer: ['note'],
    connectorIsPassThrough: ['note'],
    connectorPresentation: ['note'],
    groupId: ['note', 'timeScale'],
    stageId: ['note', ...stages],
    elevation: ['note', 'stageTransformEvent'],
} as const satisfies Record<FieldId, readonly NativeKind[]>

export type FieldFor<S extends NativeKind> = {
    [F in FieldId]: S extends (typeof fieldSubjects)[F][number] ? F : never
}[FieldId]
/** One side of an assignment: every object held this value, or they differed. */
export type AssignedValue<K extends FieldId = FieldId> =
    { readonly mode: 'varying' } | { readonly mode: 'uniform'; readonly value: FieldValue<K> }
export type Assignment<F extends FieldId = FieldId> = {
    [K in F]: {
        readonly field: K
        /** What the objects held before the edit. */
        readonly before: AssignedValue<K>
        /** What they hold after it. */
        readonly after: AssignedValue<K>
    }
}[F]

const assignedValue = (field: FieldId, data: unknown) => {
    if (!isObject(data) || !owns(data, 'mode')) return false
    if (data.mode === 'varying') return Object.keys(data).length === 1
    return (
        data.mode === 'uniform' &&
        Object.keys(data).length === 2 &&
        owns(data, 'value') &&
        fieldCodecs[field].is(data.value)
    )
}

export const assignment = codec<Assignment>((value) => {
    if (
        !isObject(value) ||
        Object.keys(value).length !== 3 ||
        !owns(value, 'field') ||
        !owns(value, 'before') ||
        !owns(value, 'after')
    )
        return false
    const field = value.field
    if (typeof field !== 'string' || !owns(fieldCodecs, field)) return false
    return (
        assignedValue(field as FieldId, value.before) &&
        assignedValue(field as FieldId, value.after)
    )
})

export const fieldApplies = (field: FieldId, kind: NativeKind) =>
    (fieldSubjects[field] as readonly NativeKind[]).includes(kind)

export const assignments = refine(
    codec<readonly Assignment[]>(
        (value) =>
            Array.isArray(value) &&
            value.length > 0 &&
            value.length <= Object.keys(fieldCodecs).length &&
            value.every(assignment.is),
    ),
    (value) =>
        value.every((item, index) => index === 0 || (value[index - 1]?.field ?? '') < item.field),
)

export type NativeCounts = Readonly<Partial<Record<NativeKind, number>>>
export type OwnerCounts = Readonly<Partial<Record<OwnerKind, number>>>

/**
 * A count map: only known keys, every value a positive integer and the sum safe. A required map
 * may be empty (nothing of that kind happened); an optional one is never stored empty.
 */
const countsOf = <const K extends readonly string[]>(keys: K, nonEmpty: boolean) =>
    codec<Readonly<Partial<Record<K[number], number>>>>(
        (value) =>
            isObject(value) &&
            Object.keys(value).every((key) => keys.includes(key) && positive.is(value[key])) &&
            (!nonEmpty || Object.keys(value).length > 0) &&
            checkedSum(Object.values(value) as number[]) !== undefined,
    )

/** Native counts that may be empty. */
export const nativeCounts = countsOf(nativeKinds, false)
/** Native counts with at least one kind (NC+). */
export const nativeCountsPlus = countsOf(nativeKinds, true)
export const ownerCounts = countsOf(ownerKinds, false)
/** Owner counts with at least one kind (OC+). */
export const ownerCountsPlus = countsOf(ownerKinds, true)

export const checkedSum = (values: Iterable<number>): number | undefined => {
    let sum = 0
    for (const value of values) {
        if (!count.is(value) || value > Number.MAX_SAFE_INTEGER - sum) return
        sum += value
    }
    return sum
}

export const subjectOfCounts = (counts: NativeCounts): Subject => {
    const kinds = nativeKinds.filter((kind) => (counts[kind] ?? 0) > 0)
    return kinds.length === 1 ? (kinds[0] ?? 'objects') : 'objects'
}
