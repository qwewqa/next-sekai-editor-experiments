import type { State } from '..'
import { maxBeat, maxLane, maxSize } from '../../chart/limits'
import { alignComputed } from '../../utils/math'
import type { Entity } from '../entities'
import type { SlideInfos } from '../entities/slides/hiddenTicks'
import { createSlideInfoLookup } from '../entities/slides/lookup'
import { isNoiseApart } from '../integrals/grid'
import { isEditableEntity, type EditableEntity, type EditableProperties } from './editable'

export type ScaleAxis = 'beat' | 'elevation' | 'width'

const slideInfoLookup = createSlideInfoLookup()

export const getScaleEntities = (selected: Entity[], axis: ScaleAxis, source?: State) =>
    [...new Set(selected.filter(isEditableEntity))].filter((entity) => {
        if (axis === 'beat') return true
        if (axis === 'width' && entity.type !== 'note') return entity.type !== 'bpm'
        if (entity.type === 'stageTransformEventJoint') return true
        if (entity.type !== 'note') return false
        if (!entity.isAttached) return true
        if (axis === 'elevation') {
            const infos = source?.store.slides.info.get(entity.slideId)
            const info =
                infos && (slideInfoLookup(infos).get(entity) as SlideInfos[number] | undefined)
            if (info?.attachHead.beat === info?.attachTail.beat && info) return true
        }
        const slide = source?.store.slides.note.get(entity.slideId)
        return slide?.[0] === entity || slide?.at(-1) === entity
    })

const widthKeys = (
    entity: EditableEntity,
): [keyof EditableProperties, (keyof EditableProperties)?] | undefined => {
    switch (entity.type) {
        case 'note':
            return ['left', 'size']
        case 'cameraEventJoint':
            return ['cameraLeft', 'cameraSize']
        case 'stageMaskEventJoint':
            return ['maskLeft', 'maskSize']
        case 'stagePivotEventJoint':
            return ['pivotLane']
        case 'stageTransformEventJoint':
            return ['xTranslation']
        case 'timeScale':
        case 'stageStyleEventJoint':
            return ['editorLane']
        case 'bpm':
            return undefined
    }
}

export const getScaleValue = (entity: EditableEntity, axis: ScaleAxis): number => {
    if (axis === 'beat') return entity.beat
    if (axis === 'elevation') return 'elevation' in entity ? entity.elevation : NaN
    const keys = widthKeys(entity)
    return keys ? Number((entity as EditableProperties)[keys[0]]) : NaN
}

export const getScaleBounds = (entity: EditableEntity, axis: ScaleAxis) => {
    const min = getScaleValue(entity, axis)
    const sizeKey = axis === 'width' ? widthKeys(entity)?.[1] : undefined
    const size = sizeKey ? Number((entity as EditableProperties)[sizeKey]) : 0
    return { min, max: min + size }
}

// Computed sizes lose their float noise, but never down to 0; unscaled ones stay exact.
const scaleSize = (size: number, factor: number) => {
    if (factor === 1) return size
    const scaled = size * factor
    const aligned = alignComputed(scaled)
    return aligned === 0 && scaled > 0 ? scaled : aligned
}
// Computed lanes lose their float noise after the order check, so noise twins may meet; unmoved ones stay exact.
const alignWidth = (axis: ScaleAxis, values: Map<EditableEntity, number>) =>
    axis === 'width'
        ? new Map(
              [...values].map(([entity, result]) => {
                  const value = getScaleValue(entity, axis)
                  return [entity, result === value ? result : alignComputed(result)] as const
              }),
          )
        : values

export const getScaleProperties = (
    entity: EditableEntity,
    axis: ScaleAxis,
    value: number,
    factor = 1,
): EditableProperties => {
    if (axis !== 'width') return { [axis]: value }
    const keys = widthKeys(entity)
    if (!keys) return {}
    const sizeKey = keys[1]
    return {
        [keys[0]]: value,
        ...(sizeKey
            ? { [sizeKey]: scaleSize(Number((entity as EditableProperties)[sizeKey]), factor) }
            : {}),
    }
}

const scalePivot = (entities: readonly EditableEntity[], axis: ScaleAxis) => {
    let pivot = Infinity
    for (const entity of entities) {
        const value = getScaleValue(entity, axis)
        if (!Number.isFinite(value)) return undefined
        pivot = Math.min(pivot, value)
    }
    return Number.isFinite(pivot) ? pivot : undefined
}

export const getScalePivot = (selected: Entity[], axis: ScaleAxis, source?: State) =>
    scalePivot(getScaleEntities(selected, axis, source), axis)

export const canScaleSelection = (selected: Entity[], axis: ScaleAxis, source?: State) => {
    const entities = getScaleEntities(selected, axis, source)
    const pivot = scalePivot(entities, axis)
    return (
        entities.length >= (axis === 'width' ? 1 : 2) &&
        pivot !== undefined &&
        entities.every((entity) => {
            const bounds = getScaleBounds(entity, axis)
            return Number.isFinite(bounds.max) && bounds.max >= bounds.min
        }) &&
        entities.some((entity) => getScaleBounds(entity, axis).max > pivot)
    )
}

export const isWithinGridBudget = (source: State, values: Map<EditableEntity, number>) => {
    const spans = new Map<
        string,
        { beforeMin: number; beforeMax: number; afterMin: number; afterMax: number }
    >()
    const include = (key: string, entity: EditableEntity) => {
        const value = values.get(entity) ?? entity.beat
        const span = spans.get(key)
        if (span) {
            span.beforeMin = Math.min(span.beforeMin, entity.beat)
            span.beforeMax = Math.max(span.beforeMax, entity.beat)
            span.afterMin = Math.min(span.afterMin, value)
            span.afterMax = Math.max(span.afterMax, value)
        } else {
            spans.set(key, {
                beforeMin: entity.beat,
                beforeMax: entity.beat,
                afterMin: value,
                afterMax: value,
            })
        }
    }
    const slides = new Set(
        [...values.keys()]
            .filter((entity) => entity.type === 'note')
            .map((entity) => entity.slideId),
    )
    for (const id of slides) {
        for (const entity of source.store.slides.note.get(id) ?? []) include(`note:${id}`, entity)
    }
    const eventTypes = new Set(
        [...values.keys()]
            .filter(
                (entity) =>
                    entity.type !== 'note' && entity.type !== 'bpm' && entity.type !== 'timeScale',
            )
            .map((entity) => entity.type),
    )
    for (const type of eventTypes) {
        for (const bucket of source.store.grid[type].values()) {
            for (const entity of bucket) {
                if (!isEditableEntity(entity)) continue
                include(`${type}:${'stageId' in entity ? entity.stageId : ''}`, entity)
            }
        }
    }
    let expansion = 0
    for (const span of spans.values()) {
        const before = Math.floor(span.beforeMax) - Math.floor(span.beforeMin)
        const after = Math.floor(span.afterMax) - Math.floor(span.afterMin)
        expansion += Math.max(0, after - before)
        if (expansion > 1_000_000) return false
    }
    return true
}

/** Whether objects can move to these beats; Scale Selection refuses results past this. */
export const isWithinBeatRange = (source: State, values: Map<EditableEntity, number>) =>
    [...values.values()].every((beat) => Math.abs(beat) <= maxBeat) &&
    isWithinGridBudget(source, values)

/** A moved beat; the editor's cleans float noise onto its grid at the division passed with it. */
type MoveBeat = (beat: number, offset: number) => number

export const addBeatOffset: MoveBeat = (beat, offset) => beat + offset

export const getScaledSelectionValues = (
    selected: Entity[],
    axis: ScaleAxis,
    factor: number,
    source?: State,
    anchor?: number,
    moveBeat = addBeatOffset,
    division = 1,
): Map<EditableEntity, number> | undefined => {
    if (
        !Number.isFinite(factor) ||
        factor <= 0 ||
        factor === 1 ||
        !canScaleSelection(selected, axis, source)
    )
        return
    const entities = getScaleEntities(selected, axis, source)
    const pivot = anchor ?? getScalePivot(entities, axis, source)
    if (pivot === undefined || !Number.isFinite(pivot)) return
    const transformed = transformValues(
        entities,
        axis,
        axis === 'beat'
            ? (value) => moveBeat(pivot, (value - pivot) * factor)
            : (value) => pivot + (value - pivot) * factor,
        source,
        division,
    )
    if (!transformed) return
    const values = alignWidth(axis, transformed)
    if (axis === 'width' && !validWidthValues(values, factor)) return
    return values
}

const validWidthValues = (values: Map<EditableEntity, number>, factor: number) => {
    for (const [entity, left] of values) {
        const sizeKey = widthKeys(entity)?.[1]
        const originalSize = sizeKey ? Number((entity as EditableProperties)[sizeKey]) : 0
        const size = scaleSize(originalSize, factor)
        if (
            !Number.isFinite(size) ||
            size < 0 ||
            size > maxSize ||
            Math.abs(left) > maxLane ||
            !Number.isFinite(left + size) ||
            (originalSize > 0 && !(left + size > left)) ||
            (entity.type === 'cameraEventJoint' && (size < 6 || size > 24))
        )
            return false
    }
    return true
}

export const getTranslatedSelectionValues = (
    selected: Entity[],
    axis: ScaleAxis,
    delta: number,
    source?: State,
    moveBeat = addBeatOffset,
    division = 1,
): Map<EditableEntity, number> | undefined => {
    if (!Number.isFinite(delta) || delta === 0) return
    const transformed = transformValues(
        getScaleEntities(selected, axis, source),
        axis,
        axis === 'beat' ? (value) => moveBeat(value, delta) : (value) => value + delta,
        source,
        division,
    )
    if (!transformed) return
    const values = alignWidth(axis, transformed)
    if (axis === 'width' && !validWidthValues(values, 1)) return
    return values
}

const transformValues = (
    entities: EditableEntity[],
    axis: ScaleAxis,
    transform: (value: number) => number,
    source?: State,
    division = 1,
) => {
    const values = new Map<EditableEntity, number>()
    let previousValue: number | undefined
    let previousTransformed: number | undefined
    // The beats so far with their results, and the largest result of those distinct from this one.
    const beats: [number, number][] = []
    let below = 0
    let distinctMax = -Infinity
    for (const entity of [...entities].sort(
        (a, b) => getScaleValue(a, axis) - getScaleValue(b, axis),
    )) {
        const value = getScaleValue(entity, axis)
        const transformed = transform(value)
        if (
            !Number.isFinite(transformed) ||
            (axis === 'beat' &&
                ((transformed < 0 && value >= 0) || Math.abs(transformed) > maxBeat))
        )
            return
        if (axis === 'beat') {
            // Beats the cleaning could merge may meet; one may not meet a beat distinct below it.
            for (
                let seen = beats[below];
                seen && !isNoiseApart(value, seen[0], division);
                seen = beats[++below]
            )
                distinctMax = Math.max(distinctMax, seen[1])
            if (transformed <= distinctMax) return
            beats.push([value, transformed])
        } else if (
            // Distinct lanes may meet by rounding; other values may not.
            previousValue !== undefined &&
            value > previousValue &&
            previousTransformed !== undefined &&
            (axis === 'width'
                ? transformed < previousTransformed
                : transformed <= previousTransformed)
        )
            return
        values.set(entity, transformed)
        previousValue = value
        previousTransformed = transformed
    }
    if (axis === 'beat' && source && !isWithinGridBudget(source, values)) return
    return new Map(
        entities.map((entity) => [entity, values.get(entity) ?? getScaleValue(entity, axis)]),
    )
}
