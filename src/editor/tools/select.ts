import type { Tool } from '.'
import type { BpmObject } from '../../chart/bpm'
import type { CameraEventObject } from '../../chart/events/camera'
import type { StageMaskEventObject } from '../../chart/events/stage/mask'
import type { StagePivotEventObject } from '../../chart/events/stage/pivot'
import type { StageStyleEventObject } from '../../chart/events/stage/style'
import type { StageTransformEventObject } from '../../chart/events/stage/transform'
import type { NoteObject } from '../../chart/note'
import type { TimeScaleObject } from '../../chart/timeScale'
import { pushState, replaceState, state } from '../../history'
import { createHistoryOperation } from '../../history/createHistoryOperation'
import { selectedEntities } from '../../history/selectedEntities'
import { i18n } from '../../i18n'
import { clearPreviewEdit, setPreviewEdit } from '../../preview/edit'
import { settings } from '../../settings'
import type { State } from '../../state'
import type { Entity, EntityType } from '../../state/entities'
import { toBpmEntity, type BpmEntity } from '../../state/entities/bpm'
import {
    toCameraEventJointEntity,
    type CameraEventJointEntity,
} from '../../state/entities/events/joints/camera'
import {
    toStageMaskEventJointEntity,
    type StageMaskEventJointEntity,
} from '../../state/entities/events/joints/stage/mask'
import {
    toStagePivotEventJointEntity,
    type StagePivotEventJointEntity,
} from '../../state/entities/events/joints/stage/pivot'
import {
    toStageStyleEventJointEntity,
    type StageStyleEventJointEntity,
} from '../../state/entities/events/joints/stage/style'
import {
    toStageTransformEventJointEntity,
    type StageTransformEventJointEntity,
} from '../../state/entities/events/joints/stage/transform'
import { toNoteEntity, type NoteEntity } from '../../state/entities/slides/note'
import { toTimeScaleEntity, type TimeScaleEntity } from '../../state/entities/timeScale'
import { beatGridKey } from '../../state/integrals/grid'
import { addBpm, removeBpm, replaceBpm } from '../../state/mutations/bpm'
import {
    addCameraEventJoint,
    removeCameraEventJoint,
    replaceCameraEventJoint,
} from '../../state/mutations/events/camera'
import {
    addStageMaskEventJoint,
    removeStageMaskEventJoint,
    replaceStageMaskEventJoint,
} from '../../state/mutations/events/stage/mask'
import {
    addStagePivotEventJoint,
    removeStagePivotEventJoint,
    replaceStagePivotEventJoint,
} from '../../state/mutations/events/stage/pivot'
import {
    addStageStyleEventJoint,
    removeStageStyleEventJoint,
    replaceStageStyleEventJoint,
} from '../../state/mutations/events/stage/style'
import {
    addStageTransformEventJoint,
    removeStageTransformEventJoint,
    replaceStageTransformEventJoint,
} from '../../state/mutations/events/stage/transform'
import { replaceNote } from '../../state/mutations/slides/note'
import { addTimeScale, removeTimeScale, replaceTimeScale } from '../../state/mutations/timeScale'
import { changedNativeCounts, editInput } from '../../state/operations/historyReceipts'
import { editChanges } from '../../state/operations/properties/plan'
import { getInStoreGrid } from '../../state/store/grid'
import { createTransaction, type Transaction } from '../../state/transaction'
import { interpolate } from '../../utils/interpolate'
import { shiftComputed } from '../../utils/math'
import { formatCount } from '../../utils/size'
import { committedGrid } from '../beatGrid'
import { inverseAffine } from '../composedPointer'
import {
    getComposedGridOffset,
    getComposedLattice,
    getComposedLayout,
    getComposedMoveOffset,
    getComposedNoteOffset,
    isComposedLatticeMoved,
} from '../composedView'
import type { Modifiers } from '../controls/gestures/pointer'
import { constrainLaneObject, minimumNoteSize } from '../laneLimits'
import { clearNotification, notify } from '../notification'
import { hitOffscreenIndicator, selectOffscreenNotes } from '../offscreenIndicators'
import { sceneState, toSceneEntity } from '../sceneState'
import { isEntityInScope } from '../scope'
import { isLatticeMoved, type Lattice } from '../snapping'
import { stepTapCycle, tapCycleSlack, type TapCycle } from '../tapCycle'
import {
    focusEntityAtBeat,
    focusViewAtBeat,
    markTouchBeat,
    setViewHover,
    toMovedBeat,
    view,
    xToLane,
    yToBeat,
    yToMoveBeatOffset,
    yToTime,
    yToValidBeat,
} from '../view'
import { getOnlyEntityType } from './entityType'
import { getMovedEndBases } from './moveBase'
import {
    getLaneAnchor,
    hitAllEntitiesInSelection,
    isSelectResize,
    modifyEntities,
    moveLane,
    offset,
    pointHitsAt,
    resize,
    resizeShift,
    selectedHit,
    toSelection,
} from './utils'

export type MoveActive = {
    type: 'move'
    lane: number
    focus: Entity
    entities: Entity[]
    onlyType: EntityType | undefined
    // The pointer's beat at the press.
    pressBeat: number
    // The pointer and lane snapping the preview was last built for.
    last?: string
    // The ghosts as built from the move, and as shown with attached notes where they drop.
    ghosts?: { ghosts: Entity[]; shown: Entity[]; snapping: string }
    response?: {
        source: State
        beatOffset: number
        zero: number
        one: number
        // The lane anchor's stage lattice in the moved chart.
        lattice: Lattice | undefined
        beatSnap: string
    }
    bases?: { source: State; beatOffset: number; beatSnap: string; bases: Bases }
}

export type RawMove = { delta: number; unconstrained?: boolean }

type Bases = ReadonlyMap<NoteEntity, NoteEntity>

/** What the grabbed object gives every moved object, once per pointer update. */
export type MovePlan = {
    bases: Bases
    // Lanes snap from it: a tick taken past its slide's end from its gameplay place, a tick within
    // its slide from its moving attach head, else its moving attach tail.
    anchor: Entity
    // A tick within its slide with neither moving can't be snapped at once.
    forcible: boolean
    // The grabbed object's moved beat.
    beat: number
    // Whether the anchor's stage lattice moved there, so absolute lane snapping can't wait.
    latticeMoved: boolean
}

let active:
    | MoveActive
    | {
          type: 'select'
          lane: number
          time: number
          count: number
          entities: Entity[]
      }
    | undefined

// Where a note is drawn, a pending draft's included; the press commits it first.
const noteOffset = (note: NoteEntity) => {
    const shown = toSceneEntity(note)
    return getComposedNoteOffset(shown, shown.beat, sceneState.value)
}

const resolveDrag = (
    x: number,
    y: number,
):
    | (MoveActive & { isSelected: boolean })
    | { type: 'select'; lane: number; indicator?: boolean } => {
    const lane = xToLane(x)
    // Off-screen badges sit over the chart; pressing one box-selects.
    if (hitOffscreenIndicator(x, y)) return { type: 'select', lane, indicator: true }
    const hits = pointHitsAt(x, y)
    const entities = hits.hits

    const focus = selectedHit(hits)
    if (focus) {
        // Selected objects in hidden or dimmed groups/stages stay put.
        const moving = selectedEntities.value.filter(isEntityInScope)
        return {
            type: 'move',
            lane: focus.type === 'note' ? lane - noteOffset(focus) : lane,
            focus,
            entities: moving,
            onlyType: getOnlyEntityType(moving),
            pressBeat: yToBeat(y),
            isSelected: true,
        }
    }

    const [entity] = entities
    if (!entity) return { type: 'select', lane }

    return {
        type: 'move',
        lane: entity.type === 'note' ? lane - noteOffset(entity) : lane,
        focus: entity,
        entities: [entity],
        onlyType: entity.type,
        pressBeat: yToBeat(y),
        isSelected: false,
    }
}

// The cycle of taps at a spot; the hover reads it, a tap keeps it.
let cycle: TapCycle<Entity, { lane: number; time: number }> | undefined

/** Ends the cycle, so the next tap starts at its spot's top. */
export const endTapCycle = () => {
    cycle = undefined
}

const isNearTap = (a: { lane: number; time: number }, b: { lane: number; time: number }) =>
    (Math.abs(a.lane - b.lane) * view.w) / settings.width <= tapCycleSlack &&
    Math.abs(a.time - b.time) * settings.pps <= tapCycleSlack

/**
 * What a tap at a point selects: with Ctrl every object hit together; else the next one after the
 * selection's first among them, or, with the selection elsewhere, the top one.
 */
const tapTargets = (x: number, y: number, modifiers: Modifiers) => {
    const { set } = pointHitsAt(x, y)
    if (modifiers.ctrl) return { targets: modifyEntities(set, modifiers) }
    const current = selectedEntities.value[0]
    const step = stepTapCycle(
        cycle,
        set,
        current,
        { lane: xToLane(x), time: yToTime(y) },
        isNearTap,
        // A pending draft's click replaces the selection it edits, which ends the cycle.
        !current || toSceneEntity(current) === current,
    )
    return {
        cycle: step.cycle,
        targets: modifyEntities(step.target ? [step.target] : [], modifiers),
    }
}

// The hover shows what a tap there would select.
const previewTap = (x: number, y: number, modifiers: Modifiers) => {
    const indicator = hitOffscreenIndicator(x, y)
    view.entities = {
        hovered: indicator
            ? modifyEntities(indicator.targets, modifiers)
            : tapTargets(x, y, modifiers).targets,
        creating: [],
    }
}

export const select: Tool = {
    title: () => i18n.value.tools.select.title,

    hover: previewTap,

    tap(x, y, modifiers) {
        const indicator = hitOffscreenIndicator(x, y)
        if (indicator) {
            selectOffscreenNotes(indicator.targets, modifiers)
            // Of its notes, the one nearest the badge.
            const at = yToBeat(y)
            const beat = indicator.targets.reduce<number | undefined>(
                (best, note) =>
                    best === undefined || Math.abs(note.beat - at) < Math.abs(best - at)
                        ? note.beat
                        : best,
                undefined,
            )
            if (beat !== undefined) markTouchBeat(beat)
            return
        }

        const { cycle: next, targets: entities } = tapTargets(x, y, modifiers)
        const [entity] = entities
        if (next) cycle = next
        if (modifiers.ctrl) {
            if (!entity) return

            const targets = entities.every((entity) => selectedEntities.value.includes(entity))
                ? selectedEntities.value.filter((entity) => !entities.includes(entity))
                : [...new Set([...selectedEntities.value, ...entities])]

            replaceState({
                ...state.value,
                selectedEntities: targets,
            })
            focusEntityAtBeat(entity.beat)

            notify(interpolate(() => i18n.value.tools.select.selected, formatCount(targets.length)))
        } else {
            const selectedLength = selectedEntities.value.length

            replaceState({
                ...state.value,
                selectedEntities: entities,
            })

            if (entity) {
                focusEntityAtBeat(entity.beat)

                notify(
                    interpolate(
                        () => i18n.value.tools.select.selected,
                        formatCount(entities.length),
                    ),
                )
            } else {
                focusViewAtBeat(yToValidBeat(y))

                if (selectedLength) notify(() => i18n.value.tools.select.deselected)
            }
        }
    },

    cursor(x, y) {
        const target = resolveDrag(x, y)
        if (target.type === 'select') return target.indicator ? 'pointer' : 'default'
        if (isSelectResize(target.onlyType, toSceneEntity(target.focus), target.lane))
            return 'ew-resize'
        return target.onlyType === 'bpm' ? 'ns-resize' : 'move'
    },

    dragStart(x, y) {
        const target = resolveDrag(x, y)
        if (target.type === 'select') {
            active = {
                type: 'select',
                lane: target.lane,
                time: yToTime(y),
                count: -1,
                entities: selectedEntities.value,
            }
        } else if (target.isSelected) {
            focusEntityAtBeat(target.focus.beat)

            notify(
                interpolate(
                    () => i18n.value.tools.select.moving,
                    formatCount(target.entities.length),
                ),
            )

            active = target
        } else {
            replaceState({
                ...state.value,
                selectedEntities: [target.focus],
            })
            view.entities = {
                hovered: [],
                creating: [],
            }
            focusEntityAtBeat(target.focus.beat)

            notify(interpolate(() => i18n.value.tools.select.moving, '1'))

            active = target
        }

        return true
    },

    dragUpdate(x, y, modifiers) {
        if (!active) return

        setViewHover(y)

        switch (active.type) {
            case 'move': {
                const { lane, beatOffset } = toPointerMove(active, x, y)

                const last = `${lane} ${beatOffset} ${view.laneDivision} ${view.laneSnapping} ${beatSnapKey()}`
                if (active.last === last) break
                active.last = last
                const source = state.value
                const { plan, rawMove } = planMove(source, active, lane, beatOffset)
                const move = active

                const ghosts: Entity[] = []
                const ghosted: Entity[] = []
                let focusBeat = active.focus.beat
                for (const entity of active.entities) {
                    if (isPinned(entity, beatOffset)) continue
                    const beat = toMovedBeat(entity.beat, beatOffset)

                    const result = creates[entity.type]?.(
                        active.onlyType,
                        entity as never,
                        active.lane,
                        lane,
                        beat,
                        active.focus,
                        rawMove,
                        plan,
                    )
                    if (!result) continue

                    ghosts.push(result)
                    ghosted.push(entity)
                    if (entity === active.focus) focusBeat = result.beat
                }

                // Selection transforms only change geometry. Pointer movement
                // within the same snapped cells should not rebuild the preview.
                // The preview reads snapping when drawn, so a snapping change rebuilds it.
                const snapping = `${view.laneDivision} ${view.laneSnapping} ${beatSnapKey()}`
                const previous = active.ghosts
                if (
                    previous?.shown === view.entities.creating &&
                    previous.snapping === snapping &&
                    ghosts.length === previous.ghosts.length &&
                    ghosts.every((entity, index) => {
                        const other = previous.ghosts[index]
                        return (
                            entity.type === other?.type &&
                            entity.beat === other.beat &&
                            entity.hitbox?.lane === other.hitbox?.lane &&
                            entity.hitbox?.w === other.hitbox?.w
                        )
                    })
                ) {
                    break
                }

                // Attached notes take their lane from the connector, so their
                // previews come from the moved chart, showing where they drop.
                const moved = active.entities.some(
                    (entity) => entity.type === 'note' && entity.isAttached,
                )
                    ? moveEntities(source, move, lane, beatOffset, plan, rawMove)
                    : undefined
                const creating = ghosts.map((ghost, index) => {
                    const entity = ghosted[index]
                    return (
                        (entity?.type === 'note' && entity.isAttached
                            ? moved?.note(entity)
                            : undefined) ?? ghost
                    )
                })
                active.ghosts = { ghosts, shown: creating, snapping }

                view.entities = {
                    hovered: [],
                    creating,
                }
                setPreviewEdit(
                    source,
                    () =>
                        (moved ?? moveEntities(source, move, lane, beatOffset, plan, rawMove))
                            .state,
                    undefined,
                    { isDrag: true },
                )
                focusEntityAtBeat(focusBeat)
                break
            }
            case 'select': {
                const selection = toSelection(active.lane, active.time, x, y)
                const entities = modifyEntities(hitAllEntitiesInSelection(selection), modifiers)
                const targets = modifiers.ctrl
                    ? [...new Set([...active.entities, ...entities])]
                    : entities

                // Moving the rectangle within the same selection only changes its overlay.
                const selected = state.value.selectedEntities
                if (
                    selected.length !== targets.length ||
                    targets.some((entity, index) => selected[index] !== entity)
                ) {
                    replaceState({
                        ...state.value,
                        selectedEntities: targets,
                    })
                }
                view.selection = selection
                view.entities = {
                    hovered: [],
                    creating: [],
                }

                if (active.count === targets.length) return
                active.count = targets.length

                notify(
                    interpolate(
                        () => i18n.value.tools.select.selecting,
                        formatCount(targets.length),
                    ),
                )
                break
            }
        }
    },

    dragEnd(x, y, modifiers) {
        if (!active) return

        switch (active.type) {
            case 'move': {
                const { lane, beatOffset } = toPointerMove(active, x, y)
                const { plan, rawMove } = planMove(state.value, active, lane, beatOffset)
                // Dropping everything where it started adds no undo step.
                if (isUnmoved(active, lane, beatOffset, rawMove, plan)) {
                    view.entities = {
                        hovered: [],
                        creating: [],
                    }
                    // Its "Moving" notice no longer holds.
                    clearNotification()
                    break
                }
                const moved = moveEntities(state.value, active, lane, beatOffset, plan, rawMove)
                const focus = isPinned(active.focus, beatOffset)
                    ? undefined
                    : creates[active.focus.type]?.(
                          active.onlyType,
                          active.focus as never,
                          active.lane,
                          lane,
                          plan.beat,
                          active.focus,
                          rawMove,
                          plan,
                      )

                const operation = createHistoryOperation(moved.operation)
                const pushed = pushState(operation, moved.state)
                view.entities = {
                    hovered: [],
                    creating: [],
                }
                focusEntityAtBeat(focus?.beat ?? active.focus.beat)

                if (pushed) notify(() => operation.fallback.text)
                break
            }
            case 'select': {
                const selection = toSelection(active.lane, active.time, x, y)
                const entities = modifyEntities(hitAllEntitiesInSelection(selection), modifiers)
                const targets = modifiers.ctrl
                    ? [...new Set([...active.entities, ...entities])]
                    : entities

                replaceState({
                    ...state.value,
                    selectedEntities: targets,
                })
                view.selection = undefined
                view.entities = {
                    hovered: [],
                    creating: [],
                }

                notify(
                    interpolate(
                        () => i18n.value.tools.select.selected,
                        formatCount(targets.length),
                    ),
                )
                break
            }
        }

        active = undefined
        clearPreviewEdit()
    },

    dragCancel() {
        active = undefined
        clearPreviewEdit()
    },
}

/**
 * Select while peeking (§1.4.11): taps and box selection change only the peeked state's
 * selection, and nothing moves or resizes.
 */
export const viewSelect: Tool = {
    title: select.title,
    hover: previewTap,
    tap: select.tap,
    cursor: (x, y) => (hitOffscreenIndicator(x, y) ? 'pointer' : 'default'),
    dragStart(x, y) {
        active = {
            type: 'select',
            lane: xToLane(x),
            time: yToTime(y),
            count: -1,
            entities: selectedEntities.value,
        }
        return true
    },
    dragUpdate: select.dragUpdate,
    dragEnd: select.dragEnd,
    dragCancel: select.dragCancel,
}

export const moveEntities = (
    source: State,
    active: MoveActive,
    lane: number,
    beatOffset: number,
    plan: MovePlan,
    rawMove?: RawMove,
) => {
    const transaction = createTransaction(source)
    const composed = getComposedLayout(source)
    // Same-beat objects move in their stored order, so they keep it.
    const rank = (entity: Entity) =>
        getInStoreGrid(source.store.grid, entity.type, entity.beat)?.indexOf(entity) ?? 0
    const entities = [...active.entities].sort(
        (a, b) =>
            (composed ? +(a.type === 'note') - +(b.type === 'note') : 0) ||
            (beatOffset > 0 ? b.beat - a.beat : a.beat - b.beat) ||
            rank(a) - rank(b),
    )
    const selectedEntities: Entity[] = []
    const displaced: Entity[] = []
    const applied = new Map<Entity, number>()
    let focusIndex = -1
    const placed = new Map<Entity, number>()
    const movingBeats = composed
        ? new Map(
              entities
                  .filter((entity) => entity.type === 'note')
                  .map((note) => [note, toMovedBeat(note.beat, beatOffset)]),
          )
        : undefined
    let destination: State | undefined
    let destinationNotes: Map<NoteEntity, NoteEntity> | undefined
    for (const entity of entities) {
        if (isPinned(entity, beatOffset)) continue
        const beat = toMovedBeat(entity.beat, beatOffset)
        if (entity === active.focus) focusIndex = selectedEntities.length
        if (entity.type === 'note') placed.set(entity, selectedEntities.length)

        // Notes and their stage events can move together. The grabbed note is
        // inverted against the resulting stage geometry; other notes retain
        // their authored offsets from that anchor.
        if (composed && entity.type === 'note') {
            if (!destination) {
                const notes = entities.filter((entity) => entity.type === 'note')
                destinationNotes = new Map()
                destination = transaction.commit([...selectedEntities, ...notes])
                // A moved BPM can rebuild attached notes. Keep the transaction's
                // replacement identities while calculating from the drag baseline.
                notes.forEach((note, index) => {
                    const replacement =
                        destination?.selectedEntities[selectedEntities.length + index]
                    if (replacement?.type === 'note') destinationNotes?.set(note, replacement)
                })
            }
            if (!applied.has(entity)) applied.set(entity, selectedEntities.length)
            selectedEntities.push(
                ...replaceNote(
                    transaction,
                    destinationNotes?.get(entity) ?? entity,
                    toMovedNoteObject(
                        active.onlyType,
                        entity,
                        active.lane,
                        lane,
                        beat,
                        active.focus,
                        rawMove,
                        plan,
                        destination,
                        movingBeats,
                    ),
                ),
            )
            continue
        }

        const result = moves[entity.type]?.(
            transaction,
            active.onlyType,
            entity as never,
            active.lane,
            lane,
            beat,
            active.focus,
            selectedEntities,
            rawMove,
            plan,
            displaced,
        )
        if (result) {
            if (result.length && !applied.has(entity)) applied.set(entity, selectedEntities.length)
            selectedEntities.push(...result)
        }
    }
    const result = transaction.commit(selectedEntities)
    const changed = changedNativeCounts(
        [...applied].flatMap(([before, index]) => {
            const after = result.selectedEntities[index]
            return after ? [{ before, after }] : []
        }),
    )
    return {
        state: result,
        // A BPM or time scale moved onto an occupied beat is a Replace, as in its own tool.
        operation: editInput('move', changed, 'objects', {
            displaced,
            retainedInitialBpm: entities.some(
                (entity) =>
                    entity.type === 'bpm' &&
                    !entity.beat &&
                    !isPinned(entity, beatOffset) &&
                    toMovedBeat(entity.beat, beatOffset) !== entity.beat,
            ),
        }),
        focus: result.selectedEntities[focusIndex],
        // A moved note as committed.
        note: (entity: NoteEntity) => {
            const index = placed.get(entity)
            const note = index === undefined ? undefined : result.selectedEntities[index]
            return note?.type === 'note' ? note : undefined
        },
    }
}

const getRawMove = (
    source: State,
    active: MoveActive,
    lane: number,
    beatOffset: number,
    plan: MovePlan,
): RawMove | undefined => {
    const composed = getComposedLayout(source)
    const focus = active.focus
    const anchor = plan.anchor
    if (
        !composed ||
        focus.type !== 'note' ||
        anchor.type !== 'note' ||
        isSelectResize(active.onlyType, focus, active.lane)
    )
        return
    // Ordinary note-only moves have a direct inverse. Mixed authored controls
    // and attached anchors can also change the projection while they move.
    if (active.onlyType === 'note' && !focus.isAttached) return
    let response = active.response
    const beatSnap = beatSnapKey()
    if (
        response?.source !== source ||
        response.beatOffset !== beatOffset ||
        response.beatSnap !== beatSnap
    ) {
        const probe = (delta: number) => {
            const result = moveEntities(source, active, active.lane + delta, beatOffset, plan, {
                delta,
                unconstrained: true,
            })
            const note = result.focus
            if (note?.type !== 'note') return { value: NaN, lattice: undefined }
            const layout = getComposedLayout(result.state)
            if (!layout) return { value: NaN, lattice: undefined }
            return {
                value: layout.noteLeft(note),
                lattice:
                    delta === 0
                        ? getComposedLattice(anchor.stageId, plan.beat, result.state)
                        : undefined,
            }
        }
        const zero = probe(0)
        const one = probe(1)
        active.response = response = {
            source,
            beatOffset,
            zero: zero.value,
            one: one.value,
            lattice: zero.lattice,
            beatSnap,
        }
    }
    const target = composed.noteLeft(focus) + lane - active.lane
    const delta = inverseAffine(
        target,
        { input: 0, output: response.zero },
        { input: 1, output: response.one },
    )
    // The moved chart's lattice decides, judged without sideways movement.
    const latticeMoved =
        plan.forcible &&
        isLatticeMoved(
            getComposedLattice(anchor.stageId, focus.beat, source),
            response.lattice,
            view.laneDivision,
        )
    // An attached anchor can have no horizontal response. Keeping the raw
    // baseline avoids moving controls that cannot move the grabbed point.
    return {
        delta:
            delta === undefined
                ? 0
                : offset(
                      0,
                      delta,
                      anchor.left,
                      response.lattice?.grid ?? 0,
                      latticeMoved ? Number.POSITIVE_INFINITY : lane - active.lane,
                  ),
    }
}

/** The grabbed object's moved beat and lane anchor, and whether its stage lattice moved. */
const getMovePlan = (source: State, active: MoveActive, beatOffset: number): MovePlan => {
    const bases = getMoveBases(source, active, beatOffset)
    const focus = active.focus
    const beat = toMovedBeat(focus.beat, beatOffset)
    const ends = focus.type === 'note' && !bases.has(focus) ? getAttachEnds(source, focus) : []
    const anchor =
        (focus.type === 'note' ? bases.get(focus) : undefined) ??
        ends.find((end) => active.entities.includes(end)) ??
        focus
    const forcible = !ends.length || anchor !== focus
    return {
        bases,
        anchor,
        forcible,
        beat,
        // The raw move judges the moved chart's lattice itself.
        latticeMoved:
            forcible &&
            anchor.type === 'note' &&
            isComposedLatticeMoved(anchor.stageId, focus.beat, beat, source),
    }
}

/** A tick within its slide takes what it lacks from its attach head, or else its attach tail. */
const getAttachEnds = (source: State, note: NoteEntity) => {
    if (!note.isAttached) return []
    const infos = source.store.slides.info.get(note.slideId)
    if (!infos || infos[0]?.note === note || infos.at(-1)?.note === note) return []
    const info = infos.find((info) => info.note === note)
    return info ? [info.attachHead, info.attachTail] : []
}

/** The selected ticks this move takes past their slide's ends, at their gameplay place. */
const getMoveBases = (source: State, active: MoveActive, beatOffset: number): Bases => {
    // Without a beat change, or in a resize, no tick crosses an end.
    if (!beatOffset || isSelectResize(active.onlyType, active.focus, active.lane)) return new Map()
    const cached = active.bases
    const beatSnap = beatSnapKey()
    if (
        cached?.source === source &&
        cached.beatOffset === beatOffset &&
        cached.beatSnap === beatSnap
    )
        return cached.bases
    const beats = new Map<NoteEntity, number>()
    for (const entity of active.entities)
        if (entity.type === 'note') beats.set(entity, toMovedBeat(entity.beat, beatOffset))
    const bases = getMovedEndBases(source, beats)
    active.bases = { source, beatOffset, beatSnap, bases }
    return bases
}

// What moved beats are cleaned against: the beat division and grid.
const beatSnapKey = () => `${view.division} ${beatGridKey(committedGrid.value)}`

const moveSelectedLane = (
    value: number,
    startLane: number,
    lane: number,
    anchor: Entity,
    rawMove?: RawMove,
) =>
    rawMove
        ? rawMove.unconstrained
            ? value + rawMove.delta
            : shiftComputed(value, rawMove.delta)
        : moveLane(value, startLane, lane, getLaneAnchor(anchor))

/** The starting BPM and time scales. */
const isInitial = (entity: Entity) =>
    (entity.type === 'bpm' || entity.type === 'timeScale') && entity.beat === 0

/** Starting values stay at 0 when the rest moves earlier. */
const isPinned = (entity: Entity, beatOffset: number) => beatOffset < 0 && isInitial(entity)

/** Shifts a move later so its earliest object stops at beat 0, as paste does. */
const toMoveBeatOffset = (active: MoveActive, beatOffset: number) =>
    active.entities.reduce(
        (offset, entity) => (isInitial(entity) ? offset : Math.max(offset, -entity.beat)),
        beatOffset,
    )

/** The move's lane and beat offset at a pointer. */
const toPointerMove = (active: MoveActive, x: number, y: number) => ({
    lane: xToLane(x) - (active.focus.type === 'note' ? getComposedNoteOffset(active.focus) : 0),
    beatOffset: toMoveBeatOffset(active, yToMoveBeatOffset(y, active.focus.beat, active.pressBeat)),
})

export const planMove = (source: State, active: MoveActive, lane: number, beatOffset: number) => {
    const plan = getMovePlan(source, active, beatOffset)
    return { plan, rawMove: getRawMove(source, active, lane, beatOffset, plan) }
}

const isUnmoved = (
    active: MoveActive,
    lane: number,
    beatOffset: number,
    rawMove: RawMove | undefined,
    plan: MovePlan,
) =>
    active.entities.every((entity) => {
        if (isPinned(entity, beatOffset)) return true
        const moved = creates[entity.type]?.(
            active.onlyType,
            entity as never,
            active.lane,
            lane,
            toMovedBeat(entity.beat, beatOffset),
            active.focus,
            rawMove,
            plan,
        )
        if (!moved) return true
        // Hitboxes are rebuilt for the preview; only the values matter.
        const values = Object.entries(moved).filter(([, value]) => typeof value !== 'object')
        return !editChanges(state.value.store, entity, Object.fromEntries(values))
    })

const toMovedBpmObject = (entity: BpmEntity, beat: number): BpmObject => ({
    ...entity,
    beat,
})

const toMovedTimeScaleObject = (
    onlyType: EntityType | undefined,
    entity: TimeScaleEntity,
    startLane: number,
    lane: number,
    beat: number,
    focus: Entity,
    rawMove?: RawMove,
): TimeScaleObject =>
    constrainLaneObject(
        {
            ...entity,
            beat,
            editorLane:
                onlyType === 'timeScale'
                    ? moveSelectedLane(entity.editorLane, startLane, lane, focus, rawMove)
                    : entity.editorLane,
        },
        {
            enabled:
                !rawMove?.unconstrained &&
                entity === focus &&
                (lane !== startLane || beat !== entity.beat),
        },
    )

const toMovedCameraEventObject = (
    onlyType: EntityType | undefined,
    entity: CameraEventJointEntity,
    startLane: number,
    lane: number,
    beat: number,
    focus: Entity,
    rawMove: RawMove | undefined,
    plan: MovePlan,
): CameraEventObject => {
    if (focus.type === 'cameraEventJoint' && isSelectResize(onlyType, focus, startLane)) {
        const fixedLeft = startLane >= focus.cameraLeft + focus.cameraSize / 2
        const edge = entity.cameraLeft + (fixedLeft ? entity.cameraSize : 0)
        const focusEdge = focus.cameraLeft + (fixedLeft ? focus.cameraSize : 0)
        // Every range's edge moves by the grabbed edge's snapped shift, as notes do.
        const [cameraLeft, cameraSize] = resize(
            shiftComputed(entity.cameraLeft, fixedLeft ? 0 : entity.cameraSize),
            edge + (lane - startLane),
            6,
            24,
            edge,
            [entity.cameraLeft, entity.cameraSize],
            undefined,
            resizeShift(focusEdge, focusEdge + (lane - startLane)),
        )

        return constrainLaneObject(
            {
                ...entity,
                cameraLeft,
                cameraSize,
            },
            {
                enabled:
                    !rawMove?.unconstrained &&
                    entity === focus &&
                    (lane !== startLane || beat !== entity.beat),
                resizing: true,
            },
        )
    }

    return constrainLaneObject(
        {
            ...entity,
            beat,
            cameraLeft: moveSelectedLane(entity.cameraLeft, startLane, lane, plan.anchor, rawMove),
        },
        {
            enabled:
                !rawMove?.unconstrained &&
                entity === focus &&
                (lane !== startLane || beat !== entity.beat),
        },
    )
}

const toMovedStageMaskEventObject = (
    onlyType: EntityType | undefined,
    entity: StageMaskEventJointEntity,
    startLane: number,
    lane: number,
    beat: number,
    focus: Entity,
    rawMove: RawMove | undefined,
    plan: MovePlan,
): StageMaskEventObject => {
    if (focus.type === 'stageMaskEventJoint' && isSelectResize(onlyType, focus, startLane)) {
        const fixedLeft = startLane >= focus.maskLeft + focus.maskSize / 2
        const edge = entity.maskLeft + (fixedLeft ? entity.maskSize : 0)
        const focusEdge = focus.maskLeft + (fixedLeft ? focus.maskSize : 0)
        const [maskLeft, maskSize] = resize(
            shiftComputed(entity.maskLeft, fixedLeft ? 0 : entity.maskSize),
            edge + (lane - startLane),
            0,
            Number.POSITIVE_INFINITY,
            edge,
            [entity.maskLeft, entity.maskSize],
            undefined,
            resizeShift(focusEdge, focusEdge + (lane - startLane)),
        )

        return constrainLaneObject(
            {
                ...entity,
                maskLeft,
                maskSize,
            },
            {
                enabled:
                    !rawMove?.unconstrained &&
                    entity === focus &&
                    (lane !== startLane || beat !== entity.beat),
                resizing: true,
            },
        )
    }

    return constrainLaneObject(
        {
            ...entity,
            beat,
            maskLeft: moveSelectedLane(entity.maskLeft, startLane, lane, plan.anchor, rawMove),
        },
        {
            enabled:
                !rawMove?.unconstrained &&
                entity === focus &&
                (lane !== startLane || beat !== entity.beat),
        },
    )
}

const toMovedStagePivotEventObject = (
    entity: StagePivotEventJointEntity,
    startLane: number,
    lane: number,
    beat: number,
    focus: Entity,
    rawMove: RawMove | undefined,
    plan: MovePlan,
): StagePivotEventObject =>
    constrainLaneObject(
        {
            ...entity,
            beat,
            pivotLane: moveSelectedLane(entity.pivotLane, startLane, lane, plan.anchor, rawMove),
        },
        {
            enabled:
                !rawMove?.unconstrained &&
                entity === focus &&
                (lane !== startLane || beat !== entity.beat),
        },
    )

const toMovedStageStyleEventObject = (
    onlyType: EntityType | undefined,
    entity: StageStyleEventJointEntity,
    startLane: number,
    lane: number,
    beat: number,
    focus: Entity,
    rawMove?: RawMove,
): StageStyleEventObject =>
    constrainLaneObject(
        {
            ...entity,
            beat,
            editorLane:
                onlyType === 'stageStyleEventJoint'
                    ? moveSelectedLane(entity.editorLane, startLane, lane, focus, rawMove)
                    : entity.editorLane,
        },
        {
            enabled:
                !rawMove?.unconstrained &&
                entity === focus &&
                (lane !== startLane || beat !== entity.beat),
        },
    )

const toMovedStageTransformEventObject = (
    entity: StageTransformEventJointEntity,
    startLane: number,
    lane: number,
    beat: number,
    focus: Entity,
    rawMove: RawMove | undefined,
    plan: MovePlan,
): StageTransformEventObject =>
    constrainLaneObject(
        {
            ...entity,
            beat,
            xTranslation: moveSelectedLane(
                entity.xTranslation,
                startLane,
                lane,
                plan.anchor,
                rawMove,
            ),
        },
        {
            enabled:
                !rawMove?.unconstrained &&
                entity === focus &&
                (lane !== startLane || beat !== entity.beat),
        },
    )

const toMovedNoteObject = (
    onlyType: EntityType | undefined,
    entity: NoteEntity,
    startLane: number,
    lane: number,
    beat: number,
    focus: Entity,
    rawMove: RawMove | undefined,
    plan: MovePlan,
    destination = state.value,
    movingBeats?: ReadonlyMap<NoteEntity, number>,
): NoteObject => {
    // A tick taken past its slide's end moves as the note it becomes, from its gameplay place.
    const from = plan.bases.get(entity) ?? entity
    if (rawMove) {
        return constrainLaneObject(
            {
                ...entity,
                beat,
                left: rawMove.unconstrained
                    ? from.left + rawMove.delta
                    : shiftComputed(from.left, rawMove.delta),
                size: from.size,
                elevation: from.elevation,
            },
            {
                enabled:
                    !rawMove.unconstrained &&
                    entity === focus &&
                    (lane !== startLane || beat !== entity.beat),
            },
        )
    }
    if (focus.type === 'note' && isSelectResize(onlyType, focus, startLane)) {
        const fixedLeft = startLane >= focus.left + focus.size / 2
        const edge = entity.left + (fixedLeft ? entity.size : 0)
        const focusEdge = focus.left + (fixedLeft ? focus.size : 0)
        // The grabbed edge's snapped shift moves every selected edge.
        const shift = resizeShift(
            focusEdge,
            focusEdge + (lane - startLane),
            getComposedLayout() ? getComposedGridOffset(focus.stageId, focus.beat) : 0,
        )

        const [left, size] = resize(
            shiftComputed(entity.left, fixedLeft ? 0 : entity.size),
            edge + (lane - startLane),
            minimumNoteSize(entity.noteType),
            Number.POSITIVE_INFINITY,
            edge,
            [entity.left, entity.size],
            undefined,
            shift,
        )

        return constrainLaneObject(
            {
                ...entity,
                left,
                size,
            },
            {
                enabled: entity === focus && (lane !== startLane || beat !== entity.beat),
                resizing: true,
            },
        )
    }

    const composed = getComposedLayout()
    const anchor = composed && focus.type === 'note' ? (plan.bases.get(focus) ?? focus) : from
    // Only the grabbed note is inverted into its destination stage. Every
    // selected note receives that same authored delta, so animated stages can
    // change their displayed spacing without changing the chart's shape.
    const correction =
        composed &&
        focus.type === 'note' &&
        (plan.beat !== anchor.beat || destination !== state.value)
            ? getComposedNoteOffset(anchor) -
              getComposedMoveOffset(anchor, plan.beat, state.value, destination, movingBeats)
            : 0

    return constrainLaneObject(
        {
            ...entity,
            beat,
            left: moveLane(
                from.left,
                startLane,
                lane + correction,
                getLaneAnchor(plan.anchor),
                composed && plan.anchor.type === 'note'
                    ? getComposedGridOffset(plan.anchor.stageId, plan.beat, destination)
                    : 0,
                // A moved stage lattice snaps at once.
                plan.latticeMoved ? Number.POSITIVE_INFINITY : lane - startLane,
            ),
            size: from.size,
            elevation: from.elevation,
        },
        {
            enabled: entity === focus && (lane !== startLane || beat !== entity.beat),
        },
    )
}

type Create<T extends Entity> = (
    onlyType: EntityType | undefined,
    entity: T,
    startLane: number,
    lane: number,
    beat: number,
    focus: Entity,
    rawMove: RawMove | undefined,
    plan: MovePlan,
) => Entity | undefined

const creates: {
    [T in Entity as T['type']]: Create<T> | undefined
} = {
    bpm: (onlyType, entity, startLane, lane, beat) => toBpmEntity(toMovedBpmObject(entity, beat)),
    timeScale: (onlyType, entity, startLane, lane, beat, focus, rawMove) =>
        toTimeScaleEntity(
            toMovedTimeScaleObject(onlyType, entity, startLane, lane, beat, focus, rawMove),
        ),

    cameraEventJoint: (onlyType, entity, startLane, lane, beat, focus, rawMove, plan) =>
        toCameraEventJointEntity(
            toMovedCameraEventObject(onlyType, entity, startLane, lane, beat, focus, rawMove, plan),
        ),
    cameraEventConnection: undefined,

    stageMaskEventJoint: (onlyType, entity, startLane, lane, beat, focus, rawMove, plan) =>
        toStageMaskEventJointEntity(
            toMovedStageMaskEventObject(
                onlyType,
                entity,
                startLane,
                lane,
                beat,
                focus,
                rawMove,
                plan,
            ),
        ),
    stageMaskEventConnection: undefined,

    stagePivotEventJoint: (onlyType, entity, startLane, lane, beat, focus, rawMove, plan) =>
        toStagePivotEventJointEntity(
            toMovedStagePivotEventObject(entity, startLane, lane, beat, focus, rawMove, plan),
        ),
    stagePivotEventConnection: undefined,

    stageStyleEventJoint: (onlyType, entity, startLane, lane, beat, focus, rawMove) =>
        toStageStyleEventJointEntity(
            toMovedStageStyleEventObject(onlyType, entity, startLane, lane, beat, focus, rawMove),
        ),
    stageStyleEventConnection: undefined,

    stageTransformEventJoint: (onlyType, entity, startLane, lane, beat, focus, rawMove, plan) =>
        toStageTransformEventJointEntity(
            toMovedStageTransformEventObject(entity, startLane, lane, beat, focus, rawMove, plan),
        ),
    stageTransformEventConnection: undefined,

    note: (onlyType, entity, startLane, lane, beat, focus, rawMove, plan) =>
        toNoteEntity(
            entity.slideId,
            toMovedNoteObject(onlyType, entity, startLane, lane, beat, focus, rawMove, plan),
            entity,
        ),
    connector: undefined,
}

type Move<T extends Entity> = (
    transaction: Transaction,
    onlyType: EntityType | undefined,
    entity: T,
    startLane: number,
    lane: number,
    beat: number,
    focus: Entity,
    /** Objects already placed by this move; they never replace each other. */
    batch: readonly Entity[],
    rawMove: RawMove | undefined,
    plan: MovePlan,
    displaced: Entity[],
) => Entity[] | undefined

const moves: {
    [T in Entity as T['type']]: Move<T> | undefined
} = {
    bpm: (
        transaction,
        onlyType,
        entity,
        startLane,
        lane,
        beat,
        focus,
        batch,
        rawMove,
        plan,
        displaced,
    ) => {
        const object = toMovedBpmObject(entity, beat)
        // A move along its beat is an edit: it keeps its place and replaces nothing.
        if (object.beat === entity.beat) return replaceBpm(transaction, entity, object)

        if (entity.beat) removeBpm(transaction, entity)

        const overlap = getInStoreGrid(transaction.store.grid, 'bpm', object.beat)?.find(
            (entity) => entity.beat === object.beat && !batch.includes(entity),
        )
        if (overlap) {
            displaced.push(overlap)
            removeBpm(transaction, overlap)
        }

        return addBpm(transaction, object)
    },
    timeScale: (
        transaction,
        onlyType,
        entity,
        startLane,
        lane,
        beat,
        focus,
        batch,
        rawMove,
        plan,
        displaced,
    ) => {
        const object = toMovedTimeScaleObject(
            onlyType,
            entity,
            startLane,
            lane,
            beat,
            focus,
            rawMove,
        )
        if (object.beat === entity.beat && object.groupId === entity.groupId)
            return replaceTimeScale(transaction, entity, object)

        removeTimeScale(transaction, entity)

        // Replaces every one of its group at the beat, a pair too, but not its own batch.
        const overlaps = getInStoreGrid(transaction.store.grid, 'timeScale', object.beat) ?? []
        for (const overlap of overlaps)
            if (
                overlap.beat === object.beat &&
                overlap.groupId === object.groupId &&
                !batch.includes(overlap)
            ) {
                displaced.push(overlap)
                removeTimeScale(transaction, overlap)
            }

        return addTimeScale(transaction, object)
    },

    cameraEventJoint: (
        transaction,
        onlyType,
        entity,
        startLane,
        lane,
        beat,
        focus,
        batch,
        rawMove,
        plan,
    ) => {
        const object = toMovedCameraEventObject(
            onlyType,
            entity,
            startLane,
            lane,
            beat,
            focus,
            rawMove,
            plan,
        )
        if (object.beat === entity.beat) return replaceCameraEventJoint(transaction, entity, object)

        removeCameraEventJoint(transaction, entity)
        return addCameraEventJoint(transaction, object)
    },
    cameraEventConnection: undefined,

    stageMaskEventJoint: (
        transaction,
        onlyType,
        entity,
        startLane,
        lane,
        beat,
        focus,
        batch,
        rawMove,
        plan,
    ) => {
        const object = toMovedStageMaskEventObject(
            onlyType,
            entity,
            startLane,
            lane,
            beat,
            focus,
            rawMove,
            plan,
        )
        if (object.beat === entity.beat && object.stageId === entity.stageId)
            return replaceStageMaskEventJoint(transaction, entity, object)

        removeStageMaskEventJoint(transaction, entity)
        return addStageMaskEventJoint(transaction, object)
    },
    stageMaskEventConnection: undefined,

    stagePivotEventJoint: (
        transaction,
        onlyType,
        entity,
        startLane,
        lane,
        beat,
        focus,
        batch,
        rawMove,
        plan,
    ) => {
        const object = toMovedStagePivotEventObject(
            entity,
            startLane,
            lane,
            beat,
            focus,
            rawMove,
            plan,
        )
        if (object.beat === entity.beat && object.stageId === entity.stageId)
            return replaceStagePivotEventJoint(transaction, entity, object)

        removeStagePivotEventJoint(transaction, entity)
        return addStagePivotEventJoint(transaction, object)
    },
    stagePivotEventConnection: undefined,

    stageStyleEventJoint: (
        transaction,
        onlyType,
        entity,
        startLane,
        lane,
        beat,
        focus,
        batch,
        rawMove,
    ) => {
        const object = toMovedStageStyleEventObject(
            onlyType,
            entity,
            startLane,
            lane,
            beat,
            focus,
            rawMove,
        )
        if (object.beat === entity.beat && object.stageId === entity.stageId)
            return replaceStageStyleEventJoint(transaction, entity, object)

        removeStageStyleEventJoint(transaction, entity)
        return addStageStyleEventJoint(transaction, object)
    },
    stageStyleEventConnection: undefined,

    stageTransformEventJoint: (
        transaction,
        onlyType,
        entity,
        startLane,
        lane,
        beat,
        focus,
        batch,
        rawMove,
        plan,
    ) => {
        const object = toMovedStageTransformEventObject(
            entity,
            startLane,
            lane,
            beat,
            focus,
            rawMove,
            plan,
        )
        if (object.beat === entity.beat && object.stageId === entity.stageId)
            return replaceStageTransformEventJoint(transaction, entity, object)

        removeStageTransformEventJoint(transaction, entity)
        return addStageTransformEventJoint(transaction, object)
    },
    stageTransformEventConnection: undefined,

    note: (transaction, onlyType, entity, startLane, lane, beat, focus, batch, rawMove, plan) => {
        const object = toMovedNoteObject(
            onlyType,
            entity,
            startLane,
            lane,
            beat,
            focus,
            rawMove,
            plan,
        )

        return replaceNote(transaction, entity, object)
    },
    connector: undefined,
}
