import { shallowRef, watch, type WatchStopHandle } from 'vue'
import { pushState, state } from '../../../history'
import { createHistoryOperation } from '../../../history/createHistoryOperation'
import {
    clearPreviewEdit,
    getPreviewState,
    previewEdit,
    setPreviewEdit,
    type PreviewEdit,
} from '../../../preview/edit'
import { settings } from '../../../settings'
import type { State } from '../../../state'
import { hasSameChartData } from '../../../state/data'
import type { Entity } from '../../../state/entities'
import { isEditableEntity, type EditableEntity } from '../../../state/operations/editable'
import { changedData, changedNativeCounts } from '../../../state/operations/historyReceipts'
import { getMaterializedNotePositions } from '../../../state/operations/notePositions'
import { scaleSelectionWithReceipt } from '../../../state/operations/scaleSelection'
import {
    canScaleSelection,
    getScaleBounds,
    getScaleEntities,
    getScaleValue,
    getScaledSelectionValues,
    getTranslatedSelectionValues,
    type ScaleAxis,
} from '../../../state/operations/scaleValues'
import {
    transformSelectionWithReceipt,
    type SelectionTransformResult,
} from '../../../state/operations/transformSelection'
import { translateSelectionWithReceipt } from '../../../state/operations/translateSelection'
import { getInStoreGrid } from '../../../state/store/grid'
import { clamp } from '../../../utils/math'
import { constrainLaneObject } from '../../laneLimits'
import { notify } from '../../notification'
import { toolName } from '../../tools/state'
import { toMovedBeat, view } from '../../view'

export type ScalingSession = {
    id: number
    source: State
    selected: Entity[]
    axis: ScaleAxis
    factor: number
    requestedFactor: number
    valid: boolean
}

type ScalingDrag = {
    baseline: EditableEntity
    bounds: { min: number; max: number }
    attached: boolean
    id: number
    source: State
    value: number
    entityValue: number
    anchor: number
    endpoint: boolean
    factor: number
    requestedFactor: number
    valid: boolean
    anchorSide: 'min' | 'max'
    edit: PreviewEdit | undefined
    lastValue?: number
}

export const scalingSession = shallowRef<ScalingSession>()
let nextId = 0
let ownedEdit: PreviewEdit | undefined
let ownerToken: symbol | undefined
let revision = 0
let publishing = false
let stopWatching: WatchStopHandle[] = []
let drag: ScalingDrag | undefined
let numericBase: State | undefined
let numericBaseFactor = 1
let anchorSide: 'min' | 'max' = 'min'
let mappedState: State | undefined
let baselineByDraft = new Map<EditableEntity, EditableEntity>()
let draftByBaseline = new Map<EditableEntity, EditableEntity>()
let baselineEntities: EditableEntity[] = []
let baselineEntitySet = new Set<EditableEntity>()
type AcceptedTransform = { mode: 'uniform'; factor: number; pivot: number } | { mode: 'composed' }
type DraftTracking = {
    live: ReadonlyMap<Entity, Entity>
    endpoints: ReadonlyMap<Entity, Entity>
    principals: ReadonlySet<Entity>
    /** Objects any step removed from a destination without moving them. */
    displaced: ReadonlySet<Entity>
    retainedInitialBpm: boolean
    transform?: AcceptedTransform
}
let tracking = new WeakMap<State, DraftTracking>()

const sourceMatches = (source: State, selected: readonly Entity[], candidate: State) =>
    candidate === source ||
    (hasSameChartData(source, candidate) &&
        candidate.bgm === source.bgm &&
        candidate.initialLife === source.initialLife &&
        candidate.selectedEntities.length === selected.length &&
        candidate.selectedEntities.every((entity, index) => entity === selected[index]))

const createDraftRecorder = (session: ScalingSession) => {
    const ledger = tracking
    const source = session.source
    const selected = [...session.selected]
    const sourceTracking = ledger.get(source)
    const get = (candidate: State) =>
        ledger.get(candidate) ??
        (sourceMatches(source, selected, candidate) ? sourceTracking : undefined)
    const track = (
        base: State,
        result: SelectionTransformResult,
        uniform?: { factor: number; pivot: number },
    ) => {
        if (result.state === base) return base
        const prior = get(base)
        if (!prior) throw new Error('Unexpected missing scaling correspondence')
        const live = new Map<Entity, Entity>()
        const endpoints = new Map(prior.endpoints)
        const principals = new Set(prior.principals)
        for (const [baseline, current] of prior.live) {
            const applied = result.applications.get(current)
            const after = result.replacements.get(current)
            if (applied) {
                principals.add(baseline)
                endpoints.set(baseline, applied)
            }
            if (after) {
                live.set(baseline, after)
                if (principals.has(baseline)) endpoints.set(baseline, after)
            }
        }
        ledger.set(result.state, {
            live,
            endpoints,
            principals,
            displaced: new Set([...prior.displaced, ...result.displaced]),
            retainedInitialBpm: prior.retainedInitialBpm || result.retainedInitialBpm,
            transform:
                prior === sourceTracking && uniform
                    ? { mode: 'uniform', ...uniform }
                    : { mode: 'composed' },
        })
        return result.state
    }
    return { get, track }
}

const sourceIsCurrent = (session: ScalingSession, candidate = state.value) =>
    sourceMatches(session.source, session.selected, candidate)
const trackingFor = (candidate: State) => {
    const known = tracking.get(candidate)
    if (known) return known
    const session = scalingSession.value
    return session && sourceIsCurrent(session) && sourceIsCurrent(session, candidate)
        ? tracking.get(session.source)
        : undefined
}
const draftState = () => (ownedEdit ? getPreviewState(state.value, ownedEdit) : state.value)
const extrema = (source: State, axis: ScaleAxis) => {
    let min = Infinity
    let max = -Infinity
    for (const entity of getScaleEntities(source.selectedEntities, axis, source)) {
        const bounds = getScaleBounds(entity, axis)
        min = Math.min(min, bounds.min)
        max = Math.max(max, bounds.max)
    }
    return { min, max }
}
const invalidateMapping = () => {
    mappedState = undefined
}
const publishDraft = (build: () => State, factor: number) => {
    const session = scalingSession.value
    if (!session || !Number.isFinite(factor) || factor <= 0) return false
    publishing = true
    try {
        scalingSession.value = { ...session, factor, requestedFactor: factor, valid: true }
        setPreviewEdit(session.source, build, [ownerToken, ++revision])
        ownedEdit = previewEdit.value
        invalidateMapping()
    } finally {
        publishing = false
    }
    return true
}

export const cancelScalingSession = () => {
    scalingSession.value = undefined
    drag = undefined
    for (const stop of stopWatching) stop()
    stopWatching = []
    if (ownedEdit && previewEdit.value === ownedEdit) clearPreviewEdit()
    ownedEdit = undefined
    ownerToken = undefined
    numericBase = undefined
    mappedState = undefined
    baselineByDraft.clear()
    draftByBaseline.clear()
    baselineEntities = []
    baselineEntitySet.clear()
    tracking = new WeakMap()
    view.entities = { hovered: [], creating: [] }
}

export const beginScalingSession = (axis: ScaleAxis) => {
    cancelScalingSession()
    const source = state.value
    const selected = [...source.selectedEntities]
    if (!canScaleSelection(selected, axis, source)) return
    clearPreviewEdit()
    ownerToken = Symbol('scaling')
    baselineEntities = selected.filter(isEditableEntity)
    baselineEntitySet = new Set(baselineEntities)
    tracking.set(source, {
        live: new Map(baselineEntities.map((entity) => [entity, entity])),
        endpoints: new Map(),
        principals: new Set(),
        displaced: new Set(),
        retainedInitialBpm: false,
    })
    numericBase = source
    numericBaseFactor = 1
    anchorSide = 'min'
    const session: ScalingSession = {
        id: ++nextId,
        source,
        selected,
        axis,
        factor: 1,
        requestedFactor: 1,
        valid: true,
    }
    scalingSession.value = session
    stopWatching = [
        watch(
            state,
            () => {
                const current = scalingSession.value
                if (current && !sourceIsCurrent(current)) cancelScalingSession()
            },
            { flush: 'sync' },
        ),
        watch(
            toolName,
            () => {
                cancelScalingSession()
            },
            { flush: 'sync' },
        ),
        watch(
            previewEdit,
            (edit) => {
                if (publishing || !scalingSession.value) return
                if ((edit && edit.dependencies?.[0] !== ownerToken) || (!edit && ownedEdit))
                    cancelScalingSession()
            },
            { flush: 'sync' },
        ),
    ]
    return session
}

export const setScalingFactor = (value: number) => {
    const session = scalingSession.value
    const base = numericBase
    if (!session || !base || !sourceIsCurrent(session)) {
        if (session) cancelScalingSession()
        return false
    }
    if (Object.is(session.requestedFactor, value)) return session.valid
    const range = extrema(base, session.axis)
    const pivot = anchorSide === 'min' ? range.min : range.max
    const ratio = value / numericBaseFactor
    const valid =
        Number.isFinite(value) &&
        value > 0 &&
        Number.isFinite(ratio) &&
        ratio > 0 &&
        (ratio === 1 ||
            getScaledSelectionValues(
                base.selectedEntities,
                session.axis,
                ratio,
                base,
                pivot,
                toMovedBeat,
                view.division,
            ) !== undefined)
    if (!valid) {
        scalingSession.value = { ...session, requestedFactor: value, valid: false }
        return false
    }
    const axis = session.axis
    const selected = base.selectedEntities
    const recorder = createDraftRecorder(session)
    return publishDraft(
        () =>
            ratio === 1
                ? base
                : recorder.track(
                      base,
                      scaleSelectionWithReceipt(
                          base,
                          selected,
                          axis,
                          ratio,
                          pivot,
                          toMovedBeat,
                          view.division,
                      ),
                      { factor: ratio, pivot },
                  ),
        value,
    )
}

export const applyScalingSession = () => {
    const session = scalingSession.value
    if (!session?.valid) return false
    if (!sourceIsCurrent(session)) {
        cancelScalingSession()
        return false
    }
    const result = draftState()
    const accepted = trackingFor(result)
    if (!accepted) throw new Error('Unexpected missing scaling receipt')
    const counts = changedNativeCounts(
        [...accepted.principals].flatMap((before) => {
            const after = accepted.endpoints.get(before)
            return after ? [{ before, after }] : []
        }),
    )
    // Only what the chart held before the session: a step can also remove an earlier step's result.
    const displaced = [...accepted.displaced].filter((entity) =>
        getInStoreGrid(session.source.store.grid, entity.type, entity.beat)?.includes(entity),
    )
    const operation = createHistoryOperation({
        id: 'nse.object.scale',
        data: {
            axis: session.axis === 'beat' ? 'beats' : session.axis,
            transform: accepted.transform ?? { mode: 'composed' },
            ...changedData(counts, 'objects', {
                displaced,
                retainedInitialBpm: accepted.retainedInitialBpm,
            }),
        },
    })
    cancelScalingSession()
    if (result === session.source) return true
    pushState(operation, result)
    notify(() => operation.fallback.text)
    return true
}

const mapDraftEntities = (draft: State) => {
    if (draft === mappedState) return
    mappedState = draft
    baselineByDraft = new Map()
    draftByBaseline = new Map()
    const accepted = trackingFor(draft)
    if (!accepted) throw new Error('Unexpected missing scaling correspondence')
    for (const [baseline, entity] of accepted.live) {
        if (!isEditableEntity(baseline) || !isEditableEntity(entity)) continue
        baselineByDraft.set(entity, baseline)
        draftByBaseline.set(baseline, entity)
    }
}
export const getScalingBaselineEntity = (entity: EditableEntity) => {
    if (!scalingSession.value) return
    if (baselineEntitySet.has(entity)) return entity
    mapDraftEntities(draftState())
    return baselineByDraft.get(entity)
}

// beginScalingDrag rejects every entity without this.
export const hasScalingRange = () => {
    const session = scalingSession.value
    if (!session) return false
    const { min, max } = extrema(draftState(), session.axis)
    return max > min
}

export const beginScalingDrag = (entity: EditableEntity, value: number, edge?: 'min' | 'max') => {
    const session = scalingSession.value
    const baseline = getScalingBaselineEntity(entity)
    if (!session || !baseline || !Number.isFinite(value)) return false
    const source = draftState()
    mapDraftEntities(source)
    const currentEntity = draftByBaseline.get(baseline)
    if (!currentEntity) return false
    const eligible = getScaleEntities(source.selectedEntities, session.axis, source).includes(
        currentEntity,
    )
    const { min, max } = extrema(source, session.axis)
    const bounds = getScaleBounds(currentEntity, session.axis)
    // Lane limits bound the slide's authored lanes, which stage translation doesn't move.
    const materialized =
        settings.maxLane > 0 && session.axis === 'width' && currentEntity.type === 'note'
            ? getMaterializedNotePositions(source, [currentEntity], undefined, {
                  translation: false,
              }).get(currentEntity)
            : undefined
    const entityValue =
        session.axis === 'width' && edge ? bounds[edge] : getScaleValue(currentEntity, session.axis)
    if (!(max > min) || !Number.isFinite(entityValue)) return false
    const anchor =
        session.axis === 'width' ? (edge === 'min' ? max : min) : entityValue === min ? max : min
    const endpoint =
        eligible &&
        (session.axis === 'width'
            ? edge !== undefined && entityValue !== anchor
            : entityValue === min || entityValue === max)
    drag = {
        baseline,
        bounds: materialized
            ? { min: materialized.left, max: materialized.left + materialized.size }
            : getScaleBounds(currentEntity, 'width'),
        attached: materialized !== undefined,
        id: session.id,
        source,
        value,
        entityValue,
        anchor,
        endpoint,
        factor: session.factor,
        requestedFactor: session.requestedFactor,
        valid: session.valid,
        anchorSide,
        edit: ownedEdit,
    }
    if (!session.valid)
        scalingSession.value = { ...session, valid: true, requestedFactor: session.factor }
    return true
}

export const updateScalingDrag = (value: number) => {
    const session = scalingSession.value
    const active = drag
    if (
        !session ||
        active?.id !== session.id ||
        !Number.isFinite(value) ||
        !sourceIsCurrent(session)
    )
        return false
    let delta = value - active.value
    if (delta === 0 && active.lastValue === undefined) return true
    const source = active.source
    const selected = source.selectedEntities
    const axis = session.axis
    if (axis === 'width' && settings.maxLane > 0) {
        if (active.endpoint) {
            delta =
                clamp(active.entityValue + delta, -settings.maxLane, settings.maxLane) -
                active.entityValue
        } else if (active.attached) {
            const constrained = constrainLaneObject({
                left: active.bounds.min + delta,
                size: active.bounds.max - active.bounds.min,
            })
            delta = constrained.left - active.bounds.min
        }
    }
    const effectiveValue = active.value + delta
    if (active.lastValue === effectiveValue) return true
    const recorder = createDraftRecorder(session)
    const constrainDraft = (result: State) => {
        if (!(settings.maxLane > 0) || active.attached) return result
        const focus = recorder.get(result)?.live.get(active.baseline)
        if (!focus || !isEditableEntity(focus)) return result
        const constrained = constrainLaneObject(focus, {
            resizing: axis === 'width' && active.endpoint,
        })
        return constrained === focus
            ? result
            : recorder.track(
                  result,
                  transformSelectionWithReceipt(
                      result,
                      result.selectedEntities,
                      new Map([[focus, constrained]]),
                  ),
              )
    }
    if (active.endpoint) {
        const anchor = active.anchor
        const ratio =
            (active.entityValue + delta - active.anchor) / (active.entityValue - active.anchor)
        const factor = active.factor * ratio
        if (
            !Number.isFinite(ratio) ||
            ratio <= 0 ||
            !Number.isFinite(factor) ||
            factor <= 0 ||
            (ratio !== 1 &&
                !getScaledSelectionValues(
                    active.source.selectedEntities,
                    session.axis,
                    ratio,
                    active.source,
                    active.anchor,
                    toMovedBeat,
                    view.division,
                ))
        )
            return false
        anchorSide = active.entityValue < active.anchor ? 'max' : 'min'
        active.lastValue = effectiveValue
        return publishDraft(
            () =>
                constrainDraft(
                    ratio === 1
                        ? source
                        : recorder.track(
                              source,
                              scaleSelectionWithReceipt(
                                  source,
                                  selected,
                                  axis,
                                  ratio,
                                  anchor,
                                  toMovedBeat,
                                  view.division,
                              ),
                              { factor: ratio, pivot: anchor },
                          ),
                ),
            factor,
        )
    }
    if (
        delta !== 0 &&
        !getTranslatedSelectionValues(
            active.source.selectedEntities,
            session.axis,
            delta,
            active.source,
            toMovedBeat,
            view.division,
        )
    )
        return false
    active.lastValue = effectiveValue
    return publishDraft(
        () =>
            constrainDraft(
                delta === 0
                    ? source
                    : recorder.track(
                          source,
                          translateSelectionWithReceipt(
                              source,
                              selected,
                              axis,
                              delta,
                              toMovedBeat,
                              view.division,
                          ),
                      ),
            ),
        active.factor,
    )
}

export const endScalingDrag = () => {
    if (!drag || drag.id !== scalingSession.value?.id) {
        drag = undefined
        return
    }
    numericBase = draftState()
    numericBaseFactor = scalingSession.value.factor
    drag = undefined
}
export const cancelScalingDrag = () => {
    const active = drag
    const session = scalingSession.value
    drag = undefined
    if (!session || active?.id !== session.id) return
    publishing = true
    try {
        scalingSession.value = {
            ...session,
            factor: active.factor,
            requestedFactor: active.requestedFactor,
            valid: active.valid,
        }
        previewEdit.value = active.edit
        ownedEdit = active.edit
        anchorSide = active.anchorSide
        invalidateMapping()
    } finally {
        publishing = false
    }
}
