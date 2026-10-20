import type { Tool } from '..'
import type { GroupId } from '../../../chart/groups'
import type { TimeScaleObject } from '../../../chart/timeScale'
import type { WithEaseEdits } from '../../../ease'
import { pushState, replaceState, state } from '../../../history'
import { createHistoryOperation } from '../../../history/createHistoryOperation'
import { defaultGroupId } from '../../../history/groups'
import { selectedEntities } from '../../../history/selectedEntities'
import { store } from '../../../history/store'
import { i18n } from '../../../i18n'
import { clearPreviewEdit, previewEdit, setPreviewEdit } from '../../../preview/edit'
import type { Entity } from '../../../state/entities'
import { toTimeScaleEntity, type TimeScaleEntity } from '../../../state/entities/timeScale'
import { addTimeScale } from '../../../state/mutations/timeScale'
import {
    countNativeEntities,
    editOutcomeInput,
    editOutcomeReceipt,
    type EditOutcomeReceipt,
} from '../../../state/operations/historyReceipts'
import {
    editTimeScale as applyTimeScaleEdit,
    editSelectedTimeScale,
    editTimeScaleWithReceipt,
} from '../../../state/operations/timeScale'
import { getInStoreGrid } from '../../../state/store/grid'
import { createTransaction, type Transaction } from '../../../state/transaction'
import { interpolate } from '../../../utils/interpolate'
import { formatCount } from '../../../utils/size'
import { revealSelectionProperties } from '../../editSelectionProperties'
import { constrainLaneObject } from '../../laneLimits'
import { notify } from '../../notification'
import { sceneState, toCommittedEntity } from '../../sceneState'
import { revealAuthoringTarget } from '../../scope'
import { isSidebarVisible, revealPropertiesSection } from '../../sidebars'
import { showToolModal } from '../../toolModals'
import {
    focusEntityAtBeat,
    isBelowSnapping,
    setViewHover,
    snapYToBeat,
    view,
    xToLane,
    xToValidLane,
    yToBeat,
    yToValidBeat,
} from '../../view'
import SelectionPropertiesModal from '../../workspace/properties/SelectionPropertiesModal.vue'
import { constrainMoved } from '../toolMove'
import { commitDrop, isVisible, moveLane, pointHitsOfType, pressTarget } from '../utils'

type MoveActive = {
    type: 'move'
    entity: TimeScaleEntity
    pressBeat: number
    lane: number
}

let active:
    | {
          type: 'add'
      }
    | MoveActive
    | undefined

export const timeScale: Tool = {
    title: () => i18n.value.tools.timeScale.title,

    hover(x, y) {
        const [entity, beat, lane] = tryFind(x, y)
        if (entity) {
            view.entities = {
                hovered: [entity],
                creating: [],
            }
        } else {
            view.entities = {
                hovered: [],
                creating: [
                    toTimeScaleEntity(
                        constrainLaneObject({
                            groupId: view.groupId ?? defaultGroupId.value,
                            beat,
                            editorLane: lane,
                            timeScale: 1,
                            skip: 0,
                            timeScaleEase: 'none',
                            timeScaleTransition: 'timeScale',
                            hideNotes: false,
                        }),
                    ),
                ],
            }
        }
    },

    tap(x, y, modifiers) {
        const [entity, beat, lane] = tryFind(x, y)
        if (entity) {
            if (modifiers.ctrl) {
                const selectedTimeScaleEntities: Entity[] = selectedEntities.value.filter(
                    (entity) => entity.type === 'timeScale',
                )

                const targets = selectedTimeScaleEntities.includes(entity)
                    ? selectedTimeScaleEntities.filter((e) => e !== entity)
                    : [...selectedTimeScaleEntities, entity]

                replaceState({
                    ...state.value,
                    selectedEntities: targets,
                })
                view.entities = {
                    hovered: [],
                    creating: [],
                }
                focusEntityAtBeat(entity.beat)

                notify(
                    interpolate(
                        () => i18n.value.tools.timeScale.selected,
                        formatCount(targets.length),
                    ),
                )
            } else {
                if (selectedEntities.value.includes(entity)) {
                    focusEntityAtBeat(entity.beat)

                    if (isSidebarVisible.value) {
                        // An explicit edit gesture on the selection shows its properties.
                        revealPropertiesSection('selection')
                    } else {
                        void showToolModal(SelectionPropertiesModal, { kind: 'timeScale' })
                    }
                } else {
                    replaceState({
                        ...state.value,
                        selectedEntities: [entity],
                    })
                    view.entities = {
                        hovered: [],
                        creating: [],
                    }
                    focusEntityAtBeat(entity.beat)

                    notify(interpolate(() => i18n.value.tools.timeScale.selected, '1'))
                }
            }
        } else {
            const object: TimeScaleObject = constrainLaneObject({
                groupId: view.groupId ?? defaultGroupId.value,
                beat,
                editorLane: lane,
                timeScale: 1,
                skip: 0,
                timeScaleEase: 'none',
                timeScaleTransition: 'timeScale',
                hideNotes: false,
            })

            // Reveal first: the placement may replace a time scale in its target group.
            revealAuthoringTarget(object)
            const overlap = find(object.groupId, object.beat)
            if (overlap) {
                edit(overlap, object)
            } else {
                add(object)
            }
            focusEntityAtBeat(object.beat)

            void revealSelectionProperties()
        }
    },

    cursor: (x, y) => (tryFind(x, y, true)[0] ? 'move' : 'crosshair'),

    dragStart(x, y) {
        const [entity, beat] = tryFind(x, y, true)
        if (entity) {
            replaceState({
                ...state.value,
                selectedEntities: [entity],
            })
            view.entities = {
                hovered: [],
                creating: [],
            }
            focusEntityAtBeat(entity.beat)

            notify(interpolate(() => i18n.value.tools.timeScale.moving, '1'))

            active = {
                type: 'move',
                entity,
                pressBeat: yToBeat(y),
                lane: xToLane(x),
            }
        } else {
            focusEntityAtBeat(beat)

            notify(interpolate(() => i18n.value.tools.timeScale.adding, '1'))

            active = {
                type: 'add',
            }
        }

        return true
    },

    dragUpdate(x, y) {
        if (!active) return

        setViewHover(y)

        switch (active.type) {
            case 'add': {
                const [entity, beat, lane] = tryFind(x, y)
                if (entity) {
                    view.entities = {
                        hovered: [entity],
                        creating: [],
                    }
                    focusEntityAtBeat(entity.beat)
                } else {
                    view.entities = {
                        hovered: [],
                        creating: [
                            toTimeScaleEntity(
                                constrainLaneObject({
                                    groupId: view.groupId ?? defaultGroupId.value,
                                    beat,
                                    editorLane: lane,
                                    timeScale: 1,
                                    skip: 0,
                                    timeScaleEase: 'none',
                                    timeScaleTransition: 'timeScale',
                                    hideNotes: false,
                                }),
                            ),
                        ],
                    }
                    focusEntityAtBeat(beat)
                }
                break
            }
            case 'move': {
                const object = toMovedObject(active, x, y)

                view.entities = {
                    hovered: [],
                    creating: [toTimeScaleEntity(object)],
                }
                previewMove(active.entity, object)
                focusEntityAtBeat(object.beat)
                break
            }
        }
    },

    dragEnd(x, y) {
        clearPreviewEdit()
        if (!active) return

        switch (active.type) {
            case 'add': {
                const [entity, beat, lane] = tryFind(x, y)
                if (entity) {
                    replaceState({
                        ...state.value,
                        selectedEntities: [entity],
                    })
                    view.entities = {
                        hovered: [],
                        creating: [],
                    }
                    focusEntityAtBeat(entity.beat)

                    notify(interpolate(() => i18n.value.tools.timeScale.selected, '1'))
                    void revealSelectionProperties()
                } else {
                    const object: TimeScaleObject = constrainLaneObject({
                        groupId: view.groupId ?? defaultGroupId.value,
                        beat,
                        editorLane: lane,
                        timeScale: 1,
                        skip: 0,
                        timeScaleEase: 'none',
                        timeScaleTransition: 'timeScale',
                        hideNotes: false,
                    })

                    // Reveal first: the placement may replace a time scale in its target group.
                    revealAuthoringTarget(object)
                    const overlap = find(object.groupId, object.beat)
                    if (overlap) {
                        edit(overlap, object)
                    } else {
                        add(object)
                    }
                    focusEntityAtBeat(object.beat)

                    void revealSelectionProperties()
                }
                break
            }
            case 'move': {
                const object = toMovedObject(active, x, y)

                commitDrop(editMoveOrReplace, active.entity, object)
                focusEntityAtBeat(object.beat)
                break
            }
        }

        active = undefined
    },

    dragCancel() {
        clearPreviewEdit()
        active = undefined
    },
}

export const editTimeScale = (
    entity: TimeScaleEntity,
    object: Partial<WithEaseEdits<TimeScaleObject>>,
) => {
    editMoveOrReplace(entity, object)
}

// Data-level lookup. A time scale created at an occupied beat of its own group
// replaces the existing one, so a group never holds two time scales at one
// beat; placement reveals the target group first, so the replaced time scale
// is always visible. The nearest-object fallback only offers fully visible
// time scales.
const find = (
    groupId: GroupId | undefined,
    beat: number,
    filter: (entity: TimeScaleEntity) => boolean = () => true,
    source = store.value,
) =>
    getInStoreGrid(source.grid, 'timeScale', beat)?.find(
        (entity) =>
            entity.beat === beat &&
            (groupId === undefined || entity.groupId === groupId) &&
            filter(entity),
    )

const tryFind = (
    x: number,
    y: number,
    grab = false,
): [TimeScaleEntity] | [undefined, number, number] => {
    const hit = pressTarget(pointHitsOfType('timeScale', x, y))
    if (hit) return [hit]

    const beat = yToValidBeat(y)
    // Every press below beat 0 snaps to it; only one within snapping of its line grabs there.
    if (grab && isBelowSnapping(y)) return [undefined, beat, xToValidLane(x)]
    // As a pending draft shows them, which the click commits first.
    const isDraft = !!previewEdit.value?.isDraft
    const shown = find(view.groupId, beat, isVisible, isDraft ? sceneState.value.store : undefined)
    const nearest = shown && isDraft ? toCommittedEntity(shown) : shown
    if (nearest) return [nearest]

    return [undefined, beat, xToValidLane(x)]
}

// Moves by the pointer's snapped movement, as Select does.
const toMovedObject = (move: MoveActive, x: number, y: number): TimeScaleObject => {
    const { entity } = move
    const lane = xToLane(x)
    return constrainMoved(
        {
            groupId: entity.groupId,
            beat: snapYToBeat(y, entity.beat, move.pressBeat),
            editorLane: moveLane(entity.editorLane, move.lane, lane, entity.editorLane),
            timeScale: entity.timeScale,
            skip: entity.skip,
            timeScaleEase: entity.timeScaleEase,
            timeScaleTransition: entity.timeScaleTransition,
            hideNotes: entity.hideNotes,
        },
        entity.beat,
        move.lane,
        lane,
    )
}

const previewMove = (entity: TimeScaleEntity, object: TimeScaleObject) => {
    const source = state.value
    setPreviewEdit(source, () => {
        const transaction = createTransaction(source)
        return transaction.commit(applyTimeScaleEdit(transaction, entity, object))
    }, [entity, object.beat, object.editorLane])
}

const editMoveOrReplace = (
    entity: TimeScaleEntity,
    object: Partial<WithEaseEdits<TimeScaleObject>>,
) => {
    const beat = object.beat ?? entity.beat
    update((transaction) => ({
        intent: entity.beat === beat ? 'edit' : 'move',
        ...editTimeScaleWithReceipt(transaction, entity, object),
    }))
    if (entity.beat !== beat) focusEntityAtBeat(beat)
}

type ToolOutcome =
    | { intent: 'add'; entities: Entity[] }
    | { intent: 'edit' | 'move'; entities: Entity[]; receipt: EditOutcomeReceipt }

const update = (action: (transaction: Transaction) => ToolOutcome) => {
    const transaction = createTransaction(state.value)
    const outcome = action(transaction)
    const result = transaction.commit(outcome.entities)
    const operation = createHistoryOperation(
        outcome.intent === 'add'
            ? {
                  id: 'nse.object.add',
                  data: {
                      subject: 'timeScale',
                      created: countNativeEntities(outcome.entities).timeScale ?? 0,
                  },
              }
            : editOutcomeInput(outcome.intent, outcome.receipt),
    )
    const pushed = pushState(operation, result)
    view.entities = { hovered: [], creating: [] }
    if (pushed) notify(() => operation.fallback.text)
}

const add = (object: TimeScaleObject) => {
    // Authoring reveals its target so the new object never vanishes.
    revealAuthoringTarget(object)
    update((transaction) => ({ intent: 'add', entities: addTimeScale(transaction, object) }))
}

const edit = (entity: TimeScaleEntity, object: TimeScaleObject) => {
    update((transaction) => {
        const entities = editSelectedTimeScale(transaction, entity, object)
        return { intent: 'edit', entities, receipt: editOutcomeReceipt(entity, entities) }
    })
}
