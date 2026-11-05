import { isPeeking, pushState, state } from '../../../history'
import { createHistoryOperation } from '../../../history/createHistoryOperation'
import { refuseWhilePeeking } from '../../../history/peek'
import { selectedEntities } from '../../../history/selectedEntities'
import { i18n } from '../../../i18n'
import type { Entity } from '../../../state/entities'
import { isEditableEntity, type EditableObject } from '../../../state/operations/editable'
import { editInput } from '../../../state/operations/historyReceipts'
import { isEditInRange, planEdit, type EachEdit } from '../../../state/operations/properties/plan'
import { notify } from '../../notification'
import { revealAuthoringTarget } from '../../scope'
import { focusEntityAtBeat, view } from '../../view'

/** Edits the selected objects, or only those `only` accepts; `each` edits each its own way. */
export const editSelectedEditableEntities = (
    object: EditableObject,
    only?: (entity: Entity) => boolean,
    each?: EachEdit,
) => {
    // Properties are read-only while peeking.
    if (isPeeking.value) {
        refuseWhilePeeking()
        return
    }
    // Refused without a notice, as fields refuse out-of-range values.
    if (!isEditInRange(state.value, selectedEntities.value, object, only, each)) return
    const {
        state: edited,
        changed,
        receipt,
        displaced,
        retainedInitialBpm,
    } = planEdit(state.value, selectedEntities.value, object, {
        only,
        each,
    })
    if (!changed.length) {
        notify(() => i18n.value.sidebars.default.noChange)
        return
    }
    if (!receipt) throw new Error('Unexpected missing property receipt')

    // An edit that reaches one BPM change or time scale and moves it is its tool's Move or Replace.
    const reached = selectedEntities.value.filter(
        (entity) => isEditableEntity(entity) && (!only || only(entity)),
    )
    const [entity] = changed
    const beat = (entity && each ? each(entity) : object).beat
    const moved =
        reached.length === 1 &&
        entity !== undefined &&
        (entity.type === 'bpm' || entity.type === 'timeScale') &&
        beat !== undefined &&
        beat !== entity.beat
    // Moving objects into a hidden group or stage reveals it, like authoring.
    revealAuthoringTarget(object)
    const operation = createHistoryOperation(
        moved
            ? editInput('move', receipt.changed, entity.type, { displaced, retainedInitialBpm })
            : { id: 'nse.property.set', data: receipt },
    )
    const pushed = pushState(operation, edited)
    view.entities = {
        hovered: [],
        creating: [],
    }

    if (pushed) notify(() => operation.fallback.text)
    if (moved) focusEntityAtBeat(beat)
}
