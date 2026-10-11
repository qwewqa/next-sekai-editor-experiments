import type { State } from '..'
import type { StageId } from '../../chart/stages'
import { easeValues } from '../../ease'
import { ease, lerp, safeUnlerpClamped, type EaseTypeValue } from '../../preview/engine/math'
import type { PreviewChart, PreviewStage } from '../../preview/engine/model'
import { getStageProps } from '../../preview/engine/stage'
import { alignComputed, clamp, nearlyEqual, shiftComputed } from '../../utils/math'
import type { EntityOfType } from '../entities'
import type { SlideId } from '../entities/slides'
import { sameBeatAttachmentFraction } from '../entities/slides/attachment'
import type { NoteEntity } from '../entities/slides/note'
import { beatToTime } from '../integrals/bpms'

type Position = { left: number; size: number; elevation: number }

const easeType = (note: NoteEntity) => easeValues[note.connectorEase] as EaseTypeValue

const unique = <T>(grid: Map<number, Set<T>>) => {
    const entities = new Set<T>()
    for (const set of grid.values()) for (const entity of set) entities.add(entity)
    return [...entities]
}

// The pivot and transform events of the stages asked for, as buildPreviewChart compiles them.
const createStageLookup = (source: State, chart?: PreviewChart) => {
    if (chart) {
        const indexes = new Map([...source.stages.keys()].map((id, index) => [id, index]))
        return (stageId: StageId) => {
            const index = source.isDynamicStages ? indexes.get(stageId) : undefined
            return index === undefined ? undefined : chart.stages[index]
        }
    }
    const toTime = (beat: number) => beatToTime(source.bpms, beat)
    let events:
        | {
              pivots: EntityOfType<'stagePivotEventJoint'>[]
              transforms: EntityOfType<'stageTransformEventJoint'>[]
          }
        | undefined
    const stages = new Map<StageId, PreviewStage>()
    return (stageId: StageId): PreviewStage | undefined => {
        if (!source.isDynamicStages || !source.stages.has(stageId)) return
        let stage = stages.get(stageId)
        if (stage) return stage
        events ??= {
            pivots: unique(source.store.grid.stagePivotEventJoint),
            transforms: unique(source.store.grid.stageTransformEventJoint),
        }
        const own = <T extends { stageId: StageId; beat: number }>(events: T[]) =>
            events.filter((event) => event.stageId === stageId).sort((a, b) => a.beat - b.beat)
        const transforms = own(events.transforms).map((event) => ({
            time: toTime(event.beat),
            rotate: (event.rotation * Math.PI) / 180,
            xLaneTranslate: event.xTranslation,
            yLaneTranslate: event.yTranslation,
            elevation: event.elevation,
            centerWeight: event.anchor === 'center' ? 1 : 0,
            ease: easeValues[event.eventEase] as EaseTypeValue,
        }))
        stage = {
            order: 0,
            drawStartTime: -1e8,
            drawEndTime: 1e8,
            masks: [],
            // Only the pivot lane is read; division and offset don't place a note.
            pivots: own(events.pivots).map((event) => ({
                time: toTime(event.beat),
                lane: event.pivotLane,
                divisionSize: event.divisionSize,
                divisionParity: event.divisionParity === 'odd' ? 1 : 0,
                yOffset: 0,
                ease: easeValues[event.eventEase] as EaseTypeValue,
            })),
            styles: [],
            transforms,
            hasTransforms: transforms.length > 0,
        }
        stages.set(stageId, stage)
        return stage
    }
}

const placeTicks = (
    source: State,
    notes: NoteEntity[],
    compiledChart: PreviewChart | undefined,
    translation: boolean,
    detached: boolean,
) => {
    const positions = new Map<NoteEntity, Position>()
    const toTime = (beat: number) => beatToTime(source.bpms, beat)
    const stageOf = createStageLookup(source, compiledChart)
    const indexes = new Map<SlideId, Map<NoteEntity, number>>()
    for (const note of notes) {
        if (!note.isAttached) continue
        const infos = source.store.slides.info.get(note.slideId)
        if (!infos) continue
        let index = indexes.get(note.slideId)
        if (!index)
            indexes.set(note.slideId, (index = new Map(infos.map((info, i) => [info.note, i]))))
        const i = index.get(note) ?? -1
        const info = infos[i]
        if (!info || i === 0 || i === infos.length - 1) continue
        const head = info.attachHead
        const tail = info.attachTail
        const time = toTime(note.beat)
        const props = (stageId: StageId) => {
            const stage = stageOf(stageId)
            return stage
                ? getStageProps(stage, time)
                : { pivotLane: 0, xLaneTranslate: 0, elevation: 0 }
        }
        const headStage = props(head.stageId)
        const tailStage = props(tail.stageId)
        const stage = props(note.stageId)
        // The compiled attachment: buildPreviewChart's attachEasedFrac and lerped half size.
        const frac = ease(
            easeType(head),
            head.beat === tail.beat
                ? safeUnlerpClamped(head.elevation, tail.elevation, note.elevation)
                : safeUnlerpClamped(toTime(head.beat), toTime(tail.beat), time),
        )
        const halfSize = Math.max(0, lerp(head.size / 2, tail.size / 2, frac))
        const elevationFrac = sameBeatAttachmentFraction(head, tail, note) ?? frac
        const headLane = head.left + head.size / 2 + headStage.pivotLane
        const tailLane = tail.left + tail.size / 2 + tailStage.pivotLane
        // Gameplay applies X translation through the blended stage transforms; 0 for a shared X.
        const translate = translation
            ? headStage.xLaneTranslate +
              (tailStage.xLaneTranslate - headStage.xLaneTranslate) * frac -
              stage.xLaneTranslate
            : 0
        const headElevation = head.elevation + headStage.elevation
        const tailElevation = tail.elevation + tailStage.elevation
        let elevation = alignComputed(
            headElevation + (tailElevation - headElevation) * elevationFrac - stage.elevation,
        )
        if (detached && head.beat === tail.beat) {
            // The input elevation, clamped as gameplay places it, stays where it plays the same.
            const kept = clamp(
                note.elevation,
                Math.min(head.elevation, tail.elevation),
                Math.max(head.elevation, tail.elevation),
            )
            if (nearlyEqual(kept, elevation)) elevation = kept
        }
        positions.set(note, {
            left: shiftComputed(
                alignComputed(headLane + (tailLane - headLane) * frac - stage.pivotLane - halfSize),
                translate,
            ),
            size: alignComputed(halfSize * 2),
            elevation,
        })
    }
    return positions
}

/** Gameplay places of interior attached ticks, from their slides and stages alone. */
export const getMaterializedNotePositions = (
    source: State,
    notes: NoteEntity[],
    compiledChart?: PreviewChart,
    { translation = true } = {},
) => placeTicks(source, notes, compiledChart, translation, false)

/** Gameplay places that detached ticks keep, as stored on their own stage. */
export const getDetachedNotePositions = (
    source: State,
    notes: NoteEntity[],
    compiledChart?: PreviewChart,
) => placeTicks(source, notes, compiledChart, true, true)
