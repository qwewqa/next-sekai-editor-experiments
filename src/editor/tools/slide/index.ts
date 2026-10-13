import { computed, ref } from 'vue'
import type { Tool } from '..'
import type { NoteObject } from '../../../chart/note'
import type { StageId } from '../../../chart/stages'
import { applyEaseEdit, type Ease } from '../../../ease'
import { pushState, replaceState, state } from '../../../history'
import { defaultGroupId } from '../../../history/groups.ts'
import { selectedEntities } from '../../../history/selectedEntities'
import { defaultStageId } from '../../../history/stages.ts'
import { store } from '../../../history/store'
import { i18n } from '../../../i18n'
import { previewEdit } from '../../../preview/edit'
import { settings } from '../../../settings'
import type { State } from '../../../state'
import type { Entity } from '../../../state/entities'
import { createSlideId, type SlideId } from '../../../state/entities/slides'
import { toNoteEntity, type NoteEntity } from '../../../state/entities/slides/note'
import { addNote, replaceNote } from '../../../state/mutations/slides/note'
import { createTransaction, type Transaction } from '../../../state/transaction'
import { interpolate } from '../../../utils/interpolate'
import { shiftComputed } from '../../../utils/math'
import { bisect } from '../../../utils/ordered'
import {
    getComposedGridOffset,
    getComposedLayout,
    getComposedNoteOffset,
    getComposedOffset,
} from '../../composedView'
import { sameBeat } from '../../elevation/layout'
import { constrainLaneObject, minimumNoteSize } from '../../laneLimits'
import { notify } from '../../notification'
import { sceneState, toSceneEntity, withDraft } from '../../sceneState'
import { revealAuthoringTarget } from '../../scope'
import { isSidebarVisible, revealPropertiesSection } from '../../sidebars'
import { showToolModal } from '../../toolModals'
import { quickEdit } from '../../utils/quickEdit'
import {
    alignLane,
    focusEntityAtBeat,
    setViewHover,
    snapYToBeat,
    view,
    xToLane,
    yToBeat,
    yToValidBeat,
    type EditorLayout,
} from '../../view'
import SelectionPropertiesModal from '../../workspace/properties/SelectionPropertiesModal.vue'
import { createEditPreview, toDraggedNoteObject, toResizedNoteObject } from '../moveBase'
import {
    addDragAnchor,
    commitDrop,
    isNoteResizeStart,
    modifyEntities,
    placementCursors,
    pointHitsOfType,
    pressTarget,
    resize,
} from '../utils'
import { previewSlideAdd, showSlideAdd, type SlideAddPreview } from './addPreview'
import SlideSidebar from './SlideSidebar.vue'

export const defaultSlidePropertiesPresetIndex = ref(0)

export const defaultSlideProperties = computed({
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    get: () => settings.defaultSlidePropertiesPresets[defaultSlidePropertiesPresetIndex.value]!,
    set: (properties) => {
        settings.defaultSlidePropertiesPresets = settings.defaultSlidePropertiesPresets.map(
            (preset, i) => (i === defaultSlidePropertiesPresetIndex.value ? properties : preset),
        )
    },
})

let active:
    | {
          type: 'add'
          lane: number
          beat: number
          stageId: StageId
      }
    | {
          type: 'edit'
          entity: NoteEntity
          lane: number
          pressBeat: number
          pressLane: number
      }
    | {
          type: 'move'
          entity: NoteEntity
          pressBeat: number
          lane: number
      }
    | undefined

export const slide: Tool = {
    title: interpolate(
        () => i18n.value.tools.slide.title,
        () => `${defaultSlidePropertiesPresetIndex.value + 1}`,
    ),
    sidebar: SlideSidebar,

    hover(x, y, modifiers) {
        // As far as a tap reaches.
        const [entity, beat, lane] = tryFind(x, y)
        if (entity) {
            view.entities = {
                hovered: modifyEntities([entity], modifiers),
                creating: [],
            }
        } else {
            view.entities = {
                hovered: [],
                creating: [
                    landing(
                        getSelectedSlideId() ?? createSlideId(),
                        constrainLaneObject({
                            beat,
                            left: lane,
                            ...getPropertiesFromSelection(beat),
                        }),
                    ),
                ],
            }
        }
    },

    tap(x, y, modifiers) {
        const [entity, beat, lane] = tryFind(x, y)
        if (entity) {
            const entities = modifyEntities([entity], modifiers)

            if (modifiers.ctrl) {
                const selectedNoteEntities: Entity[] = selectedEntities.value.filter(
                    (entity) => entity.type === 'note',
                )

                const targets = entities.every((entity) => selectedNoteEntities.includes(entity))
                    ? selectedNoteEntities.filter((entity) => !entities.includes(entity))
                    : [...new Set([...selectedNoteEntities, ...entities])]

                replaceState({
                    ...state.value,
                    selectedEntities: targets,
                })
                view.entities = {
                    hovered: [],
                    creating: [],
                }
                focusEntityAtBeat(entity.beat)

                notify(interpolate(() => i18n.value.tools.slide.selected, `${targets.length}`))
            } else {
                if (entities.every((entity) => selectedEntities.value.includes(entity))) {
                    focusEntityAtBeat(entity.beat)

                    if (isSidebarVisible.value) {
                        // An explicit edit gesture on the selection shows its properties.
                        revealPropertiesSection('selection')
                        quickEdit(defaultSlideProperties.value)
                    } else {
                        void showToolModal(SelectionPropertiesModal, { kind: 'note' })
                    }
                } else {
                    replaceState({
                        ...state.value,
                        selectedEntities: entities,
                    })
                    view.entities = {
                        hovered: [],
                        creating: [],
                    }
                    focusEntityAtBeat(entity.beat)

                    notify(interpolate(() => i18n.value.tools.slide.selected, `${entities.length}`))
                }
            }
        } else {
            add(
                getSelectedSlideId() ?? createSlideId(),
                constrainLaneObject({
                    beat,
                    left: lane,
                    ...getPropertiesFromSelection(beat),
                }),
            )
            focusEntityAtBeat(beat)
        }
    },

    cursor: (x, y) => placementCursors[resolveDrag(x, y).type],

    dragStart(x, y) {
        const target = resolveDrag(x, y)
        if (target.type === 'add') {
            focusEntityAtBeat(target.beat)

            notify(interpolate(() => i18n.value.tools.slide.adding, '1'))

            active = {
                type: 'add',
                lane: target.lane,
                beat: target.beat,
                stageId: getPropertiesFromSelection(target.beat).stageId,
            }
        } else {
            const { entity, lane } = target
            replaceState({
                ...state.value,
                selectedEntities: [entity],
            })
            view.entities = {
                hovered: [],
                creating: [],
            }
            focusEntityAtBeat(entity.beat)

            if (target.type === 'move') {
                notify(interpolate(() => i18n.value.tools.slide.moving, '1'))

                active = {
                    type: 'move',
                    entity,
                    pressBeat: yToBeat(y),
                    lane,
                }
            } else {
                notify(interpolate(() => i18n.value.tools.slide.editing, '1'))

                active = {
                    type: 'edit',
                    entity,
                    pressBeat: yToBeat(y),
                    pressLane: lane,
                    lane: shiftComputed(
                        entity.left,
                        lane >= entity.left + entity.size / 2 ? 0 : entity.size,
                    ),
                }
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
                const properties = getPropertiesFromSelection(beat)
                const lane = xToLane(x) - getComposedOffset(properties.stageId, beat)
                const anchor = addDragAnchor(active, beat, properties.stageId)
                const [left, size] = resize(
                    anchor,
                    lane,
                    minimumNoteSize(properties.noteType),
                    Number.POSITIVE_INFINITY,
                    anchor,
                    undefined,
                    getComposedGridOffset(properties.stageId, beat),
                )

                view.entities = {
                    hovered: [],
                    creating: [
                        landing(
                            getSelectedSlideId() ?? createSlideId(),
                            constrainLaneObject(
                                {
                                    beat,
                                    ...properties,
                                    left,
                                    size,
                                },
                                { resizing: true },
                            ),
                        ),
                    ],
                }
                focusEntityAtBeat(beat)
                break
            }
            case 'edit': {
                const object = toResizedNoteObject(active, x, y)

                view.entities = {
                    hovered: [],
                    creating: [
                        preview.show(active.entity, object) ??
                            toNoteEntity(active.entity.slideId, object, active.entity),
                    ],
                }
                break
            }
            case 'move': {
                const beat = snapYToBeat(y, active.entity.beat, active.pressBeat)
                const object = toDraggedNoteObject(active.entity, active.lane, x, beat)

                view.entities = {
                    hovered: [],
                    creating: [
                        preview.show(active.entity, object) ??
                            toNoteEntity(active.entity.slideId, object, active.entity),
                    ],
                }
                focusEntityAtBeat(beat)
                break
            }
        }
    },

    dragEnd(x, y) {
        preview.clear()
        if (!active) return

        switch (active.type) {
            case 'add': {
                const beat = yToValidBeat(y)
                const properties = getPropertiesFromSelection(beat)
                const lane = xToLane(x) - getComposedOffset(properties.stageId, beat)
                const anchor = addDragAnchor(active, beat, properties.stageId)
                const [left, size] = resize(
                    anchor,
                    lane,
                    minimumNoteSize(properties.noteType),
                    Number.POSITIVE_INFINITY,
                    anchor,
                    undefined,
                    getComposedGridOffset(properties.stageId, beat),
                )

                add(
                    getSelectedSlideId() ?? createSlideId(),
                    constrainLaneObject(
                        {
                            beat,
                            ...properties,
                            left,
                            size,
                        },
                        { resizing: true },
                    ),
                )
                focusEntityAtBeat(beat)
                break
            }
            case 'edit': {
                commitDrop(edit, active.entity, toResizedNoteObject(active, x, y))
                break
            }
            case 'move': {
                const beat = snapYToBeat(y, active.entity.beat, active.pressBeat)
                commitDrop(
                    move,
                    active.entity,
                    toDraggedNoteObject(active.entity, active.lane, x, beat),
                )
                focusEntityAtBeat(beat)
                break
            }
        }

        active = undefined
    },

    dragCancel() {
        preview.clear()
        active = undefined
    },
}

const getNoteFromSelection = () => {
    if (!defaultSlideProperties.value.copyProperties) return

    if (selectedEntities.value.length !== 1) return

    const [entity] = selectedEntities.value
    if (entity?.type !== 'note') return

    // As a pending draft shows it, which the click commits first.
    return withDraft(entity)
}

// As a pending draft shows the slide, which the click commits first.
const getNearestNoteInSlide = (slideId: SlideId, beat: number) => {
    const notes = (
        previewEdit.value?.isDraft ? sceneState.value.store : store.value
    ).slides.note.get(slideId)
    if (!notes) throw new Error('Unexpected notes not found')

    const index = bisect(notes, 'beat', beat)
    return notes[index - 1] ?? notes[index]
}

export const getSlidePropertiesFromSelection = (beat: number) => {
    const note = getNoteFromSelection()
    // An insert after the note takes its own.
    const nearest =
        note && (sameBeat(note.beat, beat) ? note : getNearestNoteInSlide(note.slideId, beat))

    return {
        groupId: view.groupId ?? note?.groupId ?? defaultGroupId.value,
        stageId: view.stageId ?? note?.stageId ?? defaultStageId.value,
        elevation: defaultSlideProperties.value.elevation ?? nearest?.elevation ?? 0,
        noteStyle: defaultSlideProperties.value.noteStyle ?? nearest?.noteStyle ?? 'default',
        connectorStyle:
            defaultSlideProperties.value.connectorStyle ?? nearest?.connectorStyle ?? 'default',
        noteType: defaultSlideProperties.value.noteType ?? note?.noteType ?? 'default',
        isAttached: defaultSlideProperties.value.isAttached ?? note?.isAttached ?? false,
        size: note?.size ?? view.noteSize,
        isCritical: defaultSlideProperties.value.isCritical ?? note?.isCritical ?? false,
        flickDirection:
            defaultSlideProperties.value.flickDirection ?? note?.flickDirection ?? 'none',
        isFake: defaultSlideProperties.value.isFake ?? note?.isFake ?? false,
        sfx: defaultSlideProperties.value.sfx ?? note?.sfx ?? 'default',
        isConnectorSeparator: defaultSlideProperties.value.isConnectorSeparator ?? false,
        connectorType:
            defaultSlideProperties.value.connectorType ?? nearest?.connectorType ?? 'active',
        connectorEase: applyEaseEdit<Ease>(defaultSlideProperties.value.connectorEase, 'linear'),
        connectorIsFake:
            defaultSlideProperties.value.connectorIsFake ??
            defaultSlideProperties.value.isFake ??
            nearest?.connectorIsFake ??
            false,
        connectorActiveIsCritical:
            defaultSlideProperties.value.connectorActiveIsCritical ??
            defaultSlideProperties.value.isCritical ??
            nearest?.connectorActiveIsCritical ??
            false,
        connectorGuideAlpha:
            defaultSlideProperties.value.connectorGuideAlpha ?? nearest?.connectorGuideAlpha ?? 1,
        connectorLayer:
            defaultSlideProperties.value.connectorLayer ?? nearest?.connectorLayer ?? 'top',
        connectorIsPassThrough:
            defaultSlideProperties.value.connectorIsPassThrough ??
            nearest?.connectorIsPassThrough ??
            false,
        connectorPresentation:
            defaultSlideProperties.value.connectorPresentation ??
            nearest?.connectorPresentation ??
            'default',
    }
}

const getPropertiesFromSelection = getSlidePropertiesFromSelection

const tryFind = (
    x: number,
    y: number,
    minimumNoteWidth = 1.5,
): [NoteEntity] | [undefined, number, number] => {
    // Only notes whose type, group and stage are fully visible are editable.
    const hit = pressTarget(pointHitsOfType('note', x, y, minimumNoteWidth))

    if (hit) return [hit]

    const beat = yToValidBeat(y)
    const properties = getPropertiesFromSelection(beat)
    // On the lattice drawn, a pending draft's included, as the click lands once it commits.
    const scene = sceneState.value
    const origin = getComposedGridOffset(properties.stageId, beat, scene)
    const lane =
        alignLane(xToLane(x) - getComposedOffset(properties.stageId, beat, scene) - origin) + origin
    return [undefined, beat, lane]
}

/**
 * The selected note a Slide add at its beat goes right after, as a pending draft shows it, if
 * it is in its slide in the source.
 */
export const getSlideInsertAnchor = (source: State, beat: number) => {
    if (selectedEntities.value.length !== 1) return
    const [entity] = selectedEntities.value
    if (entity?.type !== 'note') return
    const anchor = withDraft(entity)
    if (!sameBeat(anchor.beat, beat)) return
    // A draft the source doesn't show leaves the add to append.
    return source.store.slides.note.get(anchor.slideId)?.includes(anchor) ? anchor : undefined
}

export const getSelectedSlideId = () => {
    if (!selectedEntities.value.every((entity) => entity.type === 'note')) return

    const [entity] = selectedEntities.value
    if (!entity) return

    if (!selectedEntities.value.every(({ slideId }) => slideId === entity.slideId)) return

    return entity.slideId
}

const resolveDrag = (x: number, y: number) => {
    const [entity, beat, lane] = tryFind(x, y)
    if (!entity) return { type: 'add', beat, lane } as const

    // Move or resize by the note as drawn, a pending draft's included; the press commits it first.
    const shown = toSceneEntity(entity)
    const pointerLane = xToLane(x) - getComposedNoteOffset(shown, shown.beat, sceneState.value)
    return {
        type: isNoteResizeStart(shown, pointerLane) ? 'edit' : 'move',
        entity,
        lane: pointerLane,
    } as const
}

const update = (message: () => string, action: (transaction: Transaction) => Entity[]) => {
    const transaction = createTransaction(state.value)

    const selectedEntities = action(transaction)

    pushState(
        interpolate(message, `${selectedEntities.length}`),
        transaction.commit(selectedEntities),
    )
    view.entities = {
        hovered: [],
        creating: [],
    }

    notify(interpolate(message, `${selectedEntities.length}`))
}

const add = (slideId: SlideId, object: NoteObject) => {
    // Authoring reveals its target so the new object never vanishes.
    revealAuthoringTarget(object)
    const after = getSlideInsertAnchor(state.value, object.beat)
    update(
        () => i18n.value.tools.slide.added,
        (transaction) =>
            addNote(transaction, slideId, after ? { ...object, beat: after.beat } : object, after),
    )
}

// An add inside a slide shows the pieces and ticks it changes; an attached note shows on its path.
const landing = (slideId: SlideId, added: NoteObject) => {
    const source = landingSource()
    const after = getSlideInsertAnchor(source, added.beat)
    // At the anchor's beat exactly, as sorting and attaching compare beats exactly.
    const object = after ? { ...added, beat: after.beat } : added
    const preview = previewSlideAdd(source, slideId, object, after)
    if (!preview) return toNoteEntity(slideId, object)
    // A preview is its anchor's, so another anchor's never shows.
    if (lastLanding?.preview !== preview || lastLanding.layout !== view.layout)
        lastLanding = {
            preview,
            layout: view.layout,
            ghost: object.isAttached
                ? placeLanding(source, preview, object)
                : toNoteEntity(slideId, object),
        }
    return showSlideAdd(preview, lastLanding.ghost)
}

// The last landing's ghost, so a hover within one snapped placement keeps it.
let lastLanding:
    | {
          preview: SlideAddPreview
          layout: EditorLayout
          ghost: NoteEntity
      }
    | undefined

// On the path drawn, a pending draft's included, as the click lands once it commits.
const landingSource = () => (previewEdit.value?.isDraft ? sceneState.value : state.value)

const placeLanding = (source: State, { result, landed }: SlideAddPreview, object: NoteObject) => {
    const position = getComposedLayout(result)?.notePosition(landed)
    return toNoteEntity(landed.slideId, {
        ...object,
        left: position
            ? position.left - getComposedOffset(object.stageId, object.beat, source)
            : landed.left,
        size: position?.size ?? landed.size,
    })
}

const edit = (entity: NoteEntity, object: NoteObject) => {
    update(
        () => i18n.value.tools.slide.edited,
        (transaction) => replaceNote(transaction, entity, object),
    )
}

const preview = createEditPreview(replaceNote)

const move = (entity: NoteEntity, object: NoteObject) => {
    update(
        () => i18n.value.tools.slide.moved,
        (transaction) => replaceNote(transaction, entity, object),
    )
}
