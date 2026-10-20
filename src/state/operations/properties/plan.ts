import type { State } from '../..'
import { applyEaseEdit } from '../../../ease'
import type { Entity } from '../../entities'
import { addBpm } from '../../mutations/bpm'
import type { Store } from '../../store'
import { getInStoreGrid } from '../../store/grid'
import { createTransaction, type Transaction } from '../../transaction'
import { editBpmWithReceipt, editSelectedBpm } from '../bpm'
import { isEditableEntity, type EditableEntity, type EditableObject } from '../editable'
import { editSelectedCameraEvent } from '../events/camera'
import { editSelectedStageMaskEvent } from '../events/stage/mask'
import { editSelectedStagePivotEvent } from '../events/stage/pivot'
import { editSelectedStageStyleEvent } from '../events/stage/style'
import { editSelectedStageTransformEvent } from '../events/stage/transform'
import { propertyEditReceipt } from '../historyReceipts'
import { editSelectedNote } from '../note'
import { isWithinBeatRange } from '../scaleValues'
import { editSelectedTimeScale, editTimeScaleWithReceipt } from '../timeScale'
import { inStoredOrder } from '../transformSelection'
import { noteFieldsApply } from './applicability'
import { getNoteFieldsIn } from './noteFields'

export type PlanOptions = {
    /** Edits only these selected objects; the rest stay selected unchanged. */
    only?: (entity: Entity) => boolean
    /** A lone object edits as its tool would, moving or replacing by beat. */
    single?: boolean
    /** Each object's own edit, as a mixed field's step; the edit then only names its keys. */
    each?: EachEdit
}

export type EachEdit = (entity: EditableEntity) => EditableObject

const edits = {
    bpm: editSelectedBpm,
    timeScale: editSelectedTimeScale,
    cameraEventJoint: editSelectedCameraEvent,
    stageMaskEventJoint: editSelectedStageMaskEvent,
    stagePivotEventJoint: editSelectedStagePivotEvent,
    stageStyleEventJoint: editSelectedStageStyleEvent,
    stageTransformEventJoint: editSelectedStageTransformEvent,
    note: editSelectedNote,
}

/** Edits one object in place, as each kind's tool does without moving it. */
export const editEntity = (
    transaction: Transaction,
    entity: EditableEntity,
    object: EditableObject,
): Entity[] => edits[entity.type](transaction, entity as never, object)

const easeKeys = new Set(['connectorEase', 'eventEase', 'timeScaleEase'])
// Fields the slide derives when unused, such as an attached tick's lane and width.
const derivedKeys = new Set(['left', 'size'])

/** Whether an edit would change any value the object holds. */
export const editChanges = (store: Store, entity: Entity, object: EditableObject) => {
    const values = entity as unknown as Record<string, unknown>
    let applies: ((key: string) => boolean) | undefined
    for (const [key, value] of Object.entries(object as Record<string, unknown>)) {
        if (value === undefined || !(key in entity)) continue
        if (entity.type === 'note' && derivedKeys.has(key)) {
            applies ??= noteFieldsApply(getNoteFieldsIn(store, entity))
            if (!applies(key)) continue
        }
        const next = easeKeys.has(key) ? applyEaseEdit(value as never, values[key] as never) : value
        if (next !== values[key]) return true
    }
    if (entity.type !== 'note') return false
    // Fake and Critical also set the connector's flags, as the note op does.
    return (
        (object.connectorIsFake === undefined &&
            object.isFake !== undefined &&
            object.isFake !== entity.connectorIsFake) ||
        (object.connectorActiveIsCritical === undefined &&
            object.isCritical !== undefined &&
            object.isCritical !== entity.connectorActiveIsCritical)
    )
}

/** Whether an edit's beat is within the range Scale Selection keeps to. */
export const isEditInRange = (
    source: State,
    selected: Entity[],
    object: EditableObject,
    only?: (entity: Entity) => boolean,
    each?: EachEdit,
) => {
    if (object.beat === undefined) return true
    const moved = selected.flatMap((entity) => {
        if (!isEditableEntity(entity) || (only && !only(entity))) return []
        const { beat } = each ? each(entity) : object
        return beat === undefined ? [] : [[entity, beat] as const]
    })
    return isWithinBeatRange(source, new Map(moved))
}

/** What an edit of the selection does: the new state and the objects it changed. */
export const planEdit = (
    source: State,
    selected: Entity[],
    object: EditableObject,
    { only, single = true, each }: PlanOptions = {},
) => {
    if (!isEditInRange(source, selected, object, only, each))
        return { state: source, changed: [], receipt: undefined }
    const objectOf = (entity: EditableEntity) => (each ? each(entity) : object)
    const changed = selected.filter(
        (entity): entity is EditableEntity =>
            isEditableEntity(entity) &&
            (!only || only(entity)) &&
            editChanges(source.store, entity, objectOf(entity)),
    )
    const transaction = createTransaction(source)
    const editable = selected.filter(isEditableEntity)
    const lone = single && editable.length === 1 ? editable[0] : undefined
    const initialBpm = getInStoreGrid(source.store.grid, 'bpm', 0)?.find(
        (entity) => entity.beat === 0,
    )
    const results = new Map<Entity, Entity[]>()
    const requests = new Map<EditableEntity, EditableObject>()
    // What a lone BPM or time scale edit took from its destination, and the initial BPM kept.
    const displaced: Entity[] = []
    let retainedInitialBpm = false
    // Moved same-beat objects land in their stored order, whatever the selection order.
    for (const entity of inStoredOrder(source, changed, (entity) => entity)) {
        if (results.has(entity)) continue
        const own = objectOf(entity)
        requests.set(entity, { ...own })
        const alone =
            entity === lone && entity.type === 'bpm'
                ? editBpmWithReceipt(transaction, entity, own)
                : entity === lone && entity.type === 'timeScale'
                  ? editTimeScaleWithReceipt(transaction, entity, own)
                  : undefined
        if (alone) {
            displaced.push(...alone.receipt.displaced)
            retainedInitialBpm ||= alone.receipt.retainedInitialBpm
        }
        results.set(
            entity,
            alone?.entities ?? edits[entity.type](transaction, entity as never, own),
        )
        // A tick this Beat edit takes past its slide's end keeps its gameplay place, as detaching does.
        const [note] = results.get(entity) ?? []
        if (
            entity.type === 'note' &&
            entity.isAttached &&
            own.beat !== undefined &&
            note?.type === 'note'
        )
            transaction.store.setOrigin(note, entity, {
                left: own.left !== undefined,
                size: own.size !== undefined,
                elevation: own.elevation !== undefined,
            })
    }
    // The chart keeps a tempo at 0, as moves and flips do.
    if (
        initialBpm &&
        !getInStoreGrid(transaction.store.grid, 'bpm', 0)?.some((entity) => entity.beat === 0)
    ) {
        addBpm(transaction, initialBpm)
        retainedInitialBpm = true
    }
    const selection = selected.flatMap((entity) => results.get(entity) ?? [entity])
    const state = transaction.commit(selection)
    const effective = new Map<Entity, Entity | undefined>()
    selection.forEach((entity, i) => {
        if (!effective.has(entity)) effective.set(entity, state.selectedEntities[i])
    })
    const targets = [...requests].flatMap(([before, requested]) => {
        const result = results.get(before)?.[0]
        const after = result && effective.get(result)
        return after && isEditableEntity(after) ? [{ before, after, requested }] : []
    })
    return {
        state,
        changed,
        receipt: propertyEditReceipt(source, state, targets, { displaced, retainedInitialBpm }),
    }
}
