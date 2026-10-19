import { isPeeking, pushState, state } from '../../../history'
import { createHistoryOperation } from '../../../history/createHistoryOperation'
import { refuseWhilePeeking } from '../../../history/peek'
import { selectedEntities } from '../../../history/selectedEntities'
import { i18n } from '../../../i18n'
import type { Entity } from '../../../state/entities'
import { isEditableEntity, type EditableObject } from '../../../state/operations/editable'
import { isEditInRange, planEdit, type EachEdit } from '../../../state/operations/properties/plan'
import { notify } from '../../notification'
import { revealAuthoringTarget } from '../../scope'
import { editBpm } from '../../tools/bpm'
import { editTimeScale } from '../../tools/timeScale'
import { view } from '../../view'
export { isEditableEntity } from '../../../state/operations/editable'

/** Edits the selected objects, or only those `only` accepts; `each` edits each its own way. */
export const editSelectedEditableEntities = (
    object: EditableObject,
    only?: (entity: Entity) => boolean,
    each?: EachEdit,
) => {
    // Properties are read-only while peeking (§1.4.11).
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
    } = planEdit(state.value, selectedEntities.value, object, {
        only,
        each,
    })
    if (!changed.length) {
        notify(() => i18n.value.sidebars.default.noChange)
        return
    }

    // A lone BPM or time scale moving by beat says so, as its tool does.
    const [entity] = changed
    const own = entity && each ? each(entity) : object
    const delegate =
        selectedEntities.value.filter(isEditableEntity).length === 1 &&
        own.beat !== undefined &&
        own.beat !== entity?.beat &&
        (entity?.type === 'bpm' || entity?.type === 'timeScale')
    if (delegate) {
        revealAuthoringTarget(object)
        if (entity?.type === 'bpm') {
            editBpm(entity, own)
            return
        }
        if (entity?.type === 'timeScale') {
            editTimeScale(entity, own)
            return
        }
    }

    if (!receipt) throw new Error('Unexpected missing property receipt')
    // Moving objects into a hidden group or stage reveals it, like authoring.
    revealAuthoringTarget(object)
    const operation = createHistoryOperation({ id: 'nse.property.set', data: receipt })
    pushState(operation, edited)
    view.entities = {
        hovered: [],
        creating: [],
    }

    notify(() => operation.fallback.text)
}
