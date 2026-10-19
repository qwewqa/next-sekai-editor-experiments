import type { TimeScaleObject } from '../../chart/timeScale'
import { applyEaseEdit, type WithEaseEdits } from '../../ease'
import type { TimeScaleEntity } from '../entities/timeScale'
import { addTimeScale, removeTimeScale, replaceTimeScale } from '../mutations/timeScale'
import { getInStoreGrid } from '../store/grid'
import type { Transaction } from '../transaction'
import { editOutcomeReceipt } from './historyReceipts'

export const editSelectedTimeScale = (
    transaction: Transaction,
    entity: TimeScaleEntity,
    object: Partial<WithEaseEdits<TimeScaleObject>>,
) => {
    const edited = {
        groupId: object.groupId ?? entity.groupId,
        beat: object.beat ?? entity.beat,
        editorLane: object.editorLane ?? entity.editorLane,
        timeScale: object.timeScale ?? entity.timeScale,
        skip: object.skip ?? entity.skip,
        timeScaleEase: applyEaseEdit(object.timeScaleEase, entity.timeScaleEase),
        timeScaleTransition: object.timeScaleTransition ?? entity.timeScaleTransition,
        hideNotes: object.hideNotes ?? entity.hideNotes,
    }
    // Same-beat time scales of a group keep their order.
    if (edited.beat === entity.beat && edited.groupId === entity.groupId)
        return replaceTimeScale(transaction, entity, edited)

    removeTimeScale(transaction, entity)
    return addTimeScale(transaction, edited)
}

export const editTimeScaleWithReceipt = (
    transaction: Transaction,
    entity: TimeScaleEntity,
    object: Partial<WithEaseEdits<TimeScaleObject>>,
) => {
    const beat = object.beat ?? entity.beat
    const groupId = object.groupId ?? entity.groupId
    const displaced: TimeScaleEntity[] = []
    if (beat !== entity.beat) {
        // Replaces every one of its group at the beat, a pair too.
        for (const overlap of getInStoreGrid(transaction.store.grid, 'timeScale', beat) ?? [])
            if (overlap.beat === beat && overlap.groupId === groupId) {
                displaced.push(overlap)
                removeTimeScale(transaction, overlap)
            }
    }
    const entities = editSelectedTimeScale(transaction, entity, object)
    return { entities, receipt: editOutcomeReceipt(entity, entities, displaced) }
}

export const editTimeScale = (...args: Parameters<typeof editTimeScaleWithReceipt>) =>
    editTimeScaleWithReceipt(...args).entities
