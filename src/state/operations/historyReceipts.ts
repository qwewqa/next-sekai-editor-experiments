import type { State } from '..'
import {
    captureName,
    equalJson,
    fieldApplies,
    fieldCodecs,
    nativeKinds,
    subjectOfCounts,
    type Assignment,
    type FieldId,
    type FieldValue,
    type JsonValue,
    type NativeCounts,
    type NativeKind,
    type PropertyData,
} from '../../history/operations'
import type { Entity } from '../entities'
import type { EditableEntity, EditableObject } from './editable'

const kinds = {
    note: 'note',
    bpm: 'bpm',
    timeScale: 'timeScale',
    cameraEventJoint: 'cameraEvent',
    stageMaskEventJoint: 'stageMaskEvent',
    stagePivotEventJoint: 'stagePivotEvent',
    stageStyleEventJoint: 'stageStyleEvent',
    stageTransformEventJoint: 'stageTransformEvent',
} as const

/** Derived connections and connectors are not native operation operands. */
export const nativeKindOf = (entity: Entity): NativeKind | undefined =>
    kinds[entity.type as keyof typeof kinds]

export const countNativeEntities = (entities: Iterable<Entity>): NativeCounts => {
    const counts: Partial<Record<NativeKind, number>> = {}
    for (const entity of new Set(entities)) {
        const kind = nativeKindOf(entity)
        if (kind) counts[kind] = (counts[kind] ?? 0) + 1
    }
    return Object.freeze(counts)
}

export type AppliedTarget = Readonly<{ before: Entity; after: Entity }>

/** Compare principal native fields, never implementation allocation identity. */
export const nativeTargetChanged = ({ before, after }: AppliedTarget) => {
    const kind = nativeKindOf(before)
    if (!kind || nativeKindOf(after) !== kind) return false
    const old = before as unknown as Record<string, unknown>
    const next = after as unknown as Record<string, unknown>
    return (Object.keys(fieldCodecs) as FieldId[]).some(
        (field) => fieldApplies(field, kind) && old[field] !== next[field],
    )
}

export const changedNativeCounts = (pairs: Iterable<AppliedTarget>) => {
    const changed = new Set<Entity>()
    for (const pair of pairs) if (nativeTargetChanged(pair)) changed.add(pair.before)
    return countNativeEntities(changed)
}

export type EditOutcomeReceipt = Readonly<{
    subject: NativeKind
    targets: number
    created: NativeCounts
    displaced: NativeCounts
    retainedInitialBpm?: true
}>

export const editOutcomeReceipt = (
    before: EditableEntity,
    entities: readonly Entity[],
    displaced: readonly Entity[] = [],
    retainedInitialBpm = false,
): EditOutcomeReceipt => {
    const subject = kinds[before.type]
    const after = entities[0]
    return Object.freeze({
        subject,
        targets: after && nativeTargetChanged({ before, after }) ? 1 : 0,
        created: countNativeEntities(retainedInitialBpm ? entities : []),
        displaced: countNativeEntities(displaced),
        ...(retainedInitialBpm ? { retainedInitialBpm: true as const } : {}),
    })
}

export type AppliedPropertyTarget = Readonly<{
    before: EditableEntity
    after: EditableEntity
    requested: EditableObject
}>

const coupling = {
    isFake: 'connectorIsFake',
    isCritical: 'connectorActiveIsCritical',
} as const

const requestedFields = (target: AppliedPropertyTarget) => {
    const kind = kinds[target.before.type]
    return (Object.keys(target.requested) as FieldId[]).filter(
        (field) =>
            Object.hasOwn(fieldCodecs, field) &&
            target.requested[field] !== undefined &&
            fieldApplies(field, kind) &&
            field in target.before,
    )
}

const fieldChanged = ({ before, after, requested }: AppliedPropertyTarget, field: FieldId) => {
    if (before[field as keyof typeof before] !== after[field as keyof typeof after]) return true
    if (before.type !== 'note' || after.type !== 'note' || !(field in coupling)) return false
    const coupled = coupling[field as keyof typeof coupling]
    return requested[coupled] === undefined && before[coupled] !== after[coupled]
}

const effectiveValue = (
    state: State,
    entity: EditableEntity,
    field: FieldId,
): FieldValue<FieldId> => {
    const value = (entity as unknown as Record<string, unknown>)[field]
    if (field === 'groupId' || field === 'stageId') {
        const owner = field === 'groupId' ? 'group' : 'stage'
        const map = field === 'groupId' ? state.groups : state.stages
        return Object.freeze({
            kind: owner,
            id: value as number,
            name: captureName(map.get(value as never)?.name ?? ''),
        })
    }
    return value as FieldValue<FieldId>
}

/** Effective primary assignments; coupled collateral fields remain comparison detail. */
export const propertyEditReceipt = (
    state: State,
    targets: Iterable<AppliedPropertyTarget>,
): PropertyData | undefined => {
    const unique = new Map<EditableEntity, AppliedPropertyTarget>()
    for (const target of targets) if (!unique.has(target.before)) unique.set(target.before, target)
    const rows = [...unique.values()]
        .map((target) => ({ target, fields: requestedFields(target) }))
        .filter(({ target, fields }) => fields.some((field) => fieldChanged(target, field)))
    const applied = new Set(
        rows.flatMap(({ target, fields }) => fields.filter((field) => fieldChanged(target, field))),
    )
    if (!rows.length || !applied.size) return
    const assignments = [...applied].sort().map((field): Assignment => {
        const values = rows
            .filter(({ fields }) => fields.includes(field))
            .map(({ target }) => effectiveValue(state, target.after, field))
        const value = values[0]
        return Object.freeze({
            field,
            value: Object.freeze(
                value !== undefined &&
                    values.every((other) => equalJson(value as JsonValue, other as JsonValue))
                    ? { mode: 'uniform' as const, value }
                    : { mode: 'varying' as const },
            ),
        }) as Assignment
    })
    const subjects = nativeKinds.filter((kind) =>
        rows.some(({ target }) => kinds[target.before.type] === kind),
    )
    const subject = subjectOfCounts(countNativeEntities(rows.map(({ target }) => target.before)))
    return Object.freeze({
        subject,
        ...(subject === 'objects' ? { subjects: Object.freeze(subjects) } : {}),
        targets: rows.length,
        assignments: Object.freeze(assignments),
    }) as PropertyData
}
