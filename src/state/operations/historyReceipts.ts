import type { State } from '..'
import {
    captureName,
    equalJson,
    fieldApplies,
    fieldCodecs,
    resizableSubjects,
    subjectOfCounts,
    type AssignedValue,
    type Assignment,
    type FieldId,
    type FieldValue,
    type JsonValue,
    type NativeCounts,
    type NativeKind,
    type NativeOperationInput,
    type OwnerCounts,
    type PropertyData,
    type Subject,
} from '../../history/operations'
import type { Entity } from '../entities'
import { getInStoreGrid } from '../store/grid'
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

/**
 * The entities that were in `before`'s grid and are not in `after`'s: what a removal actually
 * removed, which Delete and Cut count rather than what they asked for.
 */
export const removedEntities = (before: State, after: State, entities: Iterable<Entity>) =>
    [...new Set(entities)].filter(
        (entity) =>
            nativeKindOf(entity) &&
            getInStoreGrid(before.store.grid, entity.type, entity.beat)?.includes(entity) &&
            !getInStoreGrid(after.store.grid, entity.type, entity.beat)?.includes(entity),
    )

type CountMap = Readonly<Partial<Record<string, number>>>

/**
 * The counts without zero entries, or `undefined` when none is left. Every optional count map of
 * an operation is built through this (or `countNativeEntities`): the codec refuses an empty one,
 * and a producer must never throw at `pushState`.
 */
export const nonEmpty = <T extends CountMap>(counts: T): T | undefined => {
    const kept = Object.entries(counts).filter(([, value]) => (value ?? 0) > 0)
    return kept.length ? (Object.freeze(Object.fromEntries(kept)) as T) : undefined
}

/** Spreads an optional count map into an operation's data, or nothing when it is empty. */
export const optionalCounts = <K extends string, T extends CountMap>(
    key: K,
    counts: T | undefined,
): Partial<Record<K, T>> => {
    const kept = counts && nonEmpty(counts)
    return (kept ? { [key]: kept } : {}) as Partial<Record<K, T>>
}

/** `n` objects of one kind, or the empty map when `n` is zero. */
export const kindCounts = (kind: NativeKind, n: number): NativeCounts =>
    Object.freeze(n > 0 ? { [kind]: n } : {})

/** What an owner edit counts: entries of its domain and its folders, or nothing. */
export const ownerCountsOf = (
    domain: 'group' | 'stage',
    entries: number,
    folders = 0,
): OwnerCounts | undefined =>
    nonEmpty({
        ...(entries ? { [domain]: entries } : {}),
        ...(folders ? { [`${domain}Folder`]: folders } : {}),
    })

/** Objects an edit took away or put back that were not its operands. */
export type Collateral = Readonly<{
    displaced?: Iterable<Entity>
    retainedInitialBpm?: boolean
}>

/**
 * The `displaced` and `retainedInitialBpm` fields of an operation, each only when it applies.
 * `subject` is the one the operation stores.
 */
export const collateralData = (subject: Subject, collateral: Collateral = {}) => {
    return {
        ...optionalCounts('displaced', countNativeEntities(collateral.displaced ?? [])),
        // Re-adding the initial BPM follows moving a BPM, so a step of another kind alone never has it.
        ...(collateral.retainedInitialBpm && (subject === 'bpm' || subject === 'objects')
            ? { retainedInitialBpm: true as const }
            : {}),
    }
}

/**
 * The data of an edit or move step. The subject follows the counts, and names the step on its own
 * only when nothing changed.
 */
export const changedData = (changed: NativeCounts, empty: Subject, collateral?: Collateral) => {
    const subject = Object.keys(changed).length ? subjectOfCounts(changed) : empty
    return { subject, changed, ...collateralData(subject, collateral) }
}

/**
 * Edit, Move or Replace. A BPM or time scale moved onto an occupied beat is a Replace, whichever
 * tool made the move: every changed target is that one kind, and everything displaced was too.
 */
export const editInput = (
    intent: 'edit' | 'move',
    changed: NativeCounts,
    empty: Subject,
    collateral?: Collateral,
    resized = false,
): NativeOperationInput => {
    const data = changedData(changed, empty, collateral)
    const { subject, displaced } = data
    if (
        intent === 'move' &&
        displaced &&
        (subject === 'bpm' || subject === 'timeScale') &&
        Object.keys(displaced).every((kind) => kind === subject)
    )
        return { id: 'nse.object.replace', data: { ...data, subject, displaced } }
    // A Select drag that took an edge changed the lanes' extent and nothing else, so it is a resize.
    // It is by what changed: a drag that changed a kind a resize does not reach stays a move.
    if (intent === 'move' && resized && resizableSubjects.includes(subject))
        return { id: 'nse.object.move', data: { ...data, resized: true } }
    return { id: intent === 'edit' ? 'nse.object.edit' : 'nse.object.move', data }
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
    /** The operand when its principal fields changed, else nothing. */
    changed: NativeCounts
    displaced: readonly Entity[]
    retainedInitialBpm: boolean
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
        changed: kindCounts(subject, after && nativeTargetChanged({ before, after }) ? 1 : 0),
        displaced,
        retainedInitialBpm,
    })
}

/** The Edit, Move or Replace step of one tool operand. */
export const editOutcomeInput = (intent: 'edit' | 'move', receipt: EditOutcomeReceipt) =>
    editInput(intent, receipt.changed, receipt.subject, receipt)

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

/** One side of an assignment: the value every object holds, or that they differ. */
const assigned = (values: readonly FieldValue<FieldId>[]): AssignedValue => {
    const value = values[0]
    return Object.freeze(
        value !== undefined &&
            values.every((other) => equalJson(value as JsonValue, other as JsonValue))
            ? { mode: 'uniform' as const, value }
            : { mode: 'varying' as const },
    )
}

/**
 * Effective primary assignments, each with its value before and after (coupled collateral fields
 * remain comparison detail). `source` is the state before the edit and `state` the one after it.
 */
export const propertyEditReceipt = (
    source: State,
    state: State,
    targets: Iterable<AppliedPropertyTarget>,
    collateral?: Collateral,
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
        const holders = rows.filter(({ fields }) => fields.includes(field))
        return Object.freeze({
            field,
            before: assigned(
                holders.map(({ target }) => effectiveValue(source, target.before, field)),
            ),
            after: assigned(
                holders.map(({ target }) => effectiveValue(state, target.after, field)),
            ),
        }) as Assignment
    })
    const changed = countNativeEntities(rows.map(({ target }) => target.before))
    return Object.freeze({
        subject: subjectOfCounts(changed),
        changed,
        assignments: Object.freeze(assignments),
        ...collateralData(subjectOfCounts(changed), collateral),
    }) as PropertyData
}
