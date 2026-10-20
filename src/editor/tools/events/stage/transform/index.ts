import { ref } from 'vue'
import type { Tool } from '../../..'
import type { Anchor, StageTransformEventObject } from '../../../../../chart/events/stage/transform'
import { applyEaseEdit, cycleEase, type EaseEdit, type WithEaseEdits } from '../../../../../ease'
import { pushState, replaceState, state } from '../../../../../history'
import { createHistoryOperation } from '../../../../../history/createHistoryOperation'
import { selectedEntities } from '../../../../../history/selectedEntities'
import { defaultStageId } from '../../../../../history/stages'
import { i18n } from '../../../../../i18n'
import { clearPreviewEdit, setPreviewEdit } from '../../../../../preview/edit'
import type { Entity } from '../../../../../state/entities'
import {
    toStageTransformEventJointEntity,
    type StageTransformEventJointEntity,
} from '../../../../../state/entities/events/joints/stage/transform'
import { addStageTransformEventJoint } from '../../../../../state/mutations/events/stage/transform'
import { editSelectedStageTransformEvent } from '../../../../../state/operations/events/stage/transform'
import {
    countNativeEntities,
    editInput,
    kindCounts,
    nativeTargetChanged,
} from '../../../../../state/operations/historyReceipts'
import { createTransaction, type Transaction } from '../../../../../state/transaction'
import { interpolate } from '../../../../../utils/interpolate'
import { constrainLaneObject } from '../../../../laneLimits'
import { notify } from '../../../../notification'
import { withDraft } from '../../../../sceneState'
import { revealAuthoringTarget } from '../../../../scope'
import { isSidebarVisible, revealPropertiesSection } from '../../../../sidebars'
import { showToolModal } from '../../../../toolModals'
import {
    focusEntityAtBeat,
    setViewHover,
    snapYToBeat,
    view,
    xToLane,
    xToValidLane,
    yToBeat,
    yToValidBeat,
} from '../../../../view'
import SelectionPropertiesModal from '../../../../workspace/properties/SelectionPropertiesModal.vue'
import { constrainMoved } from '../../../toolMove'
import { commitDrop, moveLane, pointHitsOfType, pressTarget } from '../../../utils'
import StageTransformEventSidebar from './StageTransformEventSidebar.vue'

type DefaultStageTransformEventProperties = {
    rotation?: number
    yTranslation?: number
    elevation?: number
    anchor?: Anchor
    eventEase?: EaseEdit
    copyProperties: boolean
}

export const defaultStageTransformEventProperties = ref<DefaultStageTransformEventProperties>({
    copyProperties: true,
})

type MoveActive = {
    type: 'move'
    entity: StageTransformEventJointEntity
    pressBeat: number
    lane: number
}

let active:
    | {
          type: 'add'
      }
    | MoveActive
    | undefined

export const stageTransformEvent: Tool = {
    title: () => i18n.value.events.stageTransformEvent,
    sidebar: StageTransformEventSidebar,

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
                    toStageTransformEventJointEntity(
                        constrainLaneObject({
                            beat,
                            xTranslation: lane,
                            ...getPropertiesFromSelection(),
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
                const selectedStageTransformEventJointEntities: Entity[] =
                    selectedEntities.value.filter(
                        (entity) => entity.type === 'stageTransformEventJoint',
                    )

                const targets = selectedStageTransformEventJointEntities.includes(entity)
                    ? selectedStageTransformEventJointEntities.filter((e) => e !== entity)
                    : [...selectedStageTransformEventJointEntities, entity]

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
                        () => i18n.value.tools.events.selected,
                        `${targets.length}`,
                        () => i18n.value.eventKinds.stageTransformEvent,
                    ),
                )
            } else {
                if (selectedEntities.value.includes(entity)) {
                    focusEntityAtBeat(entity.beat)

                    if (isSidebarVisible.value) {
                        // An explicit edit gesture on the selection shows its properties.
                        revealPropertiesSection('selection')
                        edit(entity, {
                            ...entity,
                            eventEase: cycleEase(entity.eventEase),
                        })
                    } else {
                        void showToolModal(SelectionPropertiesModal, {
                            kind: 'stageTransformEventJoint',
                        })
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

                    notify(
                        interpolate(
                            () => i18n.value.tools.events.selected,
                            '1',
                            () => i18n.value.eventKinds.stageTransformEvent,
                        ),
                    )
                }
            }
        } else {
            add(
                constrainLaneObject({
                    beat,
                    xTranslation: lane,
                    ...getPropertiesFromSelection(),
                }),
            )
            focusEntityAtBeat(beat)
        }
    },

    cursor: (x, y) => (tryFind(x, y)[0] ? 'move' : 'crosshair'),

    dragStart(x, y) {
        const [entity, beat] = tryFind(x, y)
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

            notify(
                interpolate(
                    () => i18n.value.tools.events.moving,
                    '1',
                    () => i18n.value.eventKinds.stageTransformEvent,
                ),
            )

            active = {
                type: 'move',
                entity,
                pressBeat: yToBeat(y),
                lane: xToLane(x),
            }
        } else {
            focusEntityAtBeat(beat)

            notify(
                interpolate(
                    () => i18n.value.tools.events.adding,
                    '1',
                    () => i18n.value.eventKinds.stageTransformEvent,
                ),
            )

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
                const beat = yToValidBeat(y)
                const lane = xToValidLane(x)

                view.entities = {
                    hovered: [],
                    creating: [
                        toStageTransformEventJointEntity(
                            constrainLaneObject({
                                beat,
                                xTranslation: lane,
                                ...getPropertiesFromSelection(),
                            }),
                        ),
                    ],
                }
                focusEntityAtBeat(beat)
                break
            }
            case 'move': {
                const object = toMovedObject(active, x, y)

                view.entities = {
                    hovered: [],
                    creating: [toStageTransformEventJointEntity(object)],
                }
                focusEntityAtBeat(object.beat)
                break
            }
        }

        if (active.type !== 'add') {
            const source = state.value
            const entity = active.entity
            const [replacement] = view.entities.creating
            if (replacement?.type === 'stageTransformEventJoint') {
                setPreviewEdit(source, () => {
                    const transaction = createTransaction(source)
                    return transaction.commit(
                        editSelectedStageTransformEvent(transaction, entity, replacement),
                    )
                }, [entity, replacement.beat, replacement.xTranslation])
            }
        }
    },

    dragEnd(x, y) {
        clearPreviewEdit()
        if (!active) return

        switch (active.type) {
            case 'add': {
                const beat = yToValidBeat(y)
                const lane = xToValidLane(x)

                add(
                    constrainLaneObject({
                        beat,
                        xTranslation: lane,
                        ...getPropertiesFromSelection(),
                    }),
                )
                focusEntityAtBeat(beat)
                break
            }
            case 'move': {
                const object = toMovedObject(active, x, y)

                commitDrop(move, active.entity, object)
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

// Moves by the pointer's snapped movement, as Select does.
const toMovedObject = (move: MoveActive, x: number, y: number): StageTransformEventObject => {
    const lane = xToLane(x)
    return constrainMoved(
        {
            ...move.entity,
            beat: snapYToBeat(y, move.entity.beat, move.pressBeat),
            xTranslation: moveLane(
                move.entity.xTranslation,
                move.lane,
                lane,
                move.entity.xTranslation,
            ),
        },
        move.entity.beat,
        move.lane,
        lane,
    )
}

const getStageTransformEventJointFromSelection = () => {
    if (!defaultStageTransformEventProperties.value.copyProperties) return

    if (selectedEntities.value.length !== 1) return

    const [entity] = selectedEntities.value
    if (entity?.type !== 'stageTransformEventJoint') return

    // As a pending draft shows it, which the click commits first.
    return withDraft(entity)
}

const getPropertiesFromSelection = () => {
    const stageTransformEventJoint = getStageTransformEventJointFromSelection()

    return {
        stageId: view.stageId ?? stageTransformEventJoint?.stageId ?? defaultStageId.value,
        rotation:
            defaultStageTransformEventProperties.value.rotation ??
            stageTransformEventJoint?.rotation ??
            0,
        yTranslation:
            defaultStageTransformEventProperties.value.yTranslation ??
            stageTransformEventJoint?.yTranslation ??
            0,
        elevation:
            defaultStageTransformEventProperties.value.elevation ??
            stageTransformEventJoint?.elevation ??
            0,
        anchor:
            defaultStageTransformEventProperties.value.anchor ??
            stageTransformEventJoint?.anchor ??
            'default',
        eventEase: applyEaseEdit(
            defaultStageTransformEventProperties.value.eventEase,
            stageTransformEventJoint?.eventEase ?? 'linear',
        ),
    }
}

const tryFind = (
    x: number,
    y: number,
): [StageTransformEventJointEntity] | [undefined, number, number] => {
    const hit = pressTarget(pointHitsOfType('stageTransformEventJoint', x, y))

    return hit ? [hit] : [undefined, yToValidBeat(y), xToValidLane(x)]
}

const update = (
    intent: 'add' | 'edit' | 'move',
    action: (transaction: Transaction) => Entity[],
    before?: Entity,
) => {
    const transaction = createTransaction(state.value)
    const entities = action(transaction)
    const result = transaction.commit(entities)
    const after = result.selectedEntities[0]
    const operation = createHistoryOperation(
        intent === 'add'
            ? {
                  id: 'nse.object.add',
                  data: {
                      subject: 'stageTransformEvent',
                      created: countNativeEntities(entities).stageTransformEvent ?? 0,
                  },
              }
            : editInput(
                  intent,
                  kindCounts(
                      'stageTransformEvent',
                      before && after && nativeTargetChanged({ before, after }) ? 1 : 0,
                  ),
                  'stageTransformEvent',
              ),
    )
    pushState(operation, result)
    view.entities = { hovered: [], creating: [] }
    notify(() => operation.fallback.text)
}

const add = (object: StageTransformEventObject) => {
    // Authoring reveals its target so the new object never vanishes.
    revealAuthoringTarget(object)
    update('add', (transaction) => addStageTransformEventJoint(transaction, object))
}

const edit = (
    entity: StageTransformEventJointEntity,
    object: Partial<WithEaseEdits<StageTransformEventObject>>,
) => {
    update(
        'edit',
        (transaction) => editSelectedStageTransformEvent(transaction, entity, object),
        entity,
    )
}

const move = (entity: StageTransformEventJointEntity, object: StageTransformEventObject) => {
    update(
        'move',
        (transaction) => editSelectedStageTransformEvent(transaction, entity, object),
        entity,
    )
}
