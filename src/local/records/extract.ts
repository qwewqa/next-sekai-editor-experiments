import type { Chart } from '../../chart'
import type { BpmObject } from '../../chart/bpm'
import type { CameraEventObject } from '../../chart/events/camera'
import type { StageMaskEventObject } from '../../chart/events/stage/mask'
import type { StagePivotEventObject } from '../../chart/events/stage/pivot'
import type { StageStyleEventObject } from '../../chart/events/stage/style'
import type { StageTransformEventObject } from '../../chart/events/stage/transform'
import type { NoteObject } from '../../chart/note'
import type { TimeScaleObject } from '../../chart/timeScale'
import type { State } from '../../state'
import type { BpmEntity } from '../../state/entities/bpm'
import type { CameraEventJointEntity } from '../../state/entities/events/joints/camera'
import type { StageMaskEventJointEntity } from '../../state/entities/events/joints/stage/mask'
import type { StagePivotEventJointEntity } from '../../state/entities/events/joints/stage/pivot'
import type { StageStyleEventJointEntity } from '../../state/entities/events/joints/stage/style'
import type { StageTransformEventJointEntity } from '../../state/entities/events/joints/stage/transform'
import type { SlideId } from '../../state/entities/slides'
import type { NoteEntity } from '../../state/entities/slides/note'
import type { TimeScaleEntity } from '../../state/entities/timeScale'
import type { Store } from '../../state/store'
import type { RecordValue } from './canonical'
import {
    bpmRecord,
    cameraEventRecord,
    slideRecord,
    sortEventRecords,
    sortSlideRecords,
    stageMaskEventRecord,
    stagePivotEventRecord,
    stageStyleEventRecord,
    stageTransformEventRecord,
    timeScaleRecord,
} from './encode'

// The `State`→`Chart` extractor (§1.6.2) and the one emission order: `toRecords` and the
// level-data serializer both take a state's entities in this order (§1.6.11.6), so level data
// is a function of the record set.

/** Every entity of a grid once, in bucket order; joints sit in one bucket each. */
const entitiesOf = <T>(grid: Map<number, Set<T>>) => {
    const entities = new Set<T>()
    for (const bucket of grid.values()) for (const entity of bucket) entities.add(entity)
    return [...entities]
}

/**
 * Joints in chain order, track by track: same-beat joints are ordered by their chain, which
 * playback follows, and buckets don't keep it. A joint no chain reaches still comes out.
 */
const inChainOrder = <J>(
    joints: Map<number, Set<J>>,
    connections: Map<number, Set<{ min: J; max: J }>>,
    heads: Iterable<J>,
) => {
    const next = new Map<J, J>()
    for (const { min, max } of entitiesOf(connections)) next.set(min, max)
    const ordered: J[] = []
    const seen = new Set<J>()
    for (const head of heads) {
        for (let joint: J | undefined = head; joint && !seen.has(joint); joint = next.get(joint)) {
            seen.add(joint)
            ordered.push(joint)
        }
    }
    for (const joint of entitiesOf(joints)) if (!seen.has(joint)) ordered.push(joint)
    return ordered
}

/** An entity in the emission order, with its record. */
export type Ordered<T> = { entity: T; key: number; record: readonly RecordValue[] }

export type OrderedSlide = Ordered<readonly NoteEntity[]> & { slideId: SlideId }

/** A store's records' entities in the v1 order (§1.6.11.1), kind by kind. */
export type OrderedStore = {
    slides: OrderedSlide[]
    bpms: Ordered<BpmEntity>[]
    timeScales: Ordered<TimeScaleEntity>[]
    cameraEvents: Ordered<CameraEventJointEntity>[]
    stageMaskEvents: Ordered<StageMaskEventJointEntity>[]
    stagePivotEvents: Ordered<StagePivotEventJointEntity>[]
    stageStyleEvents: Ordered<StageStyleEventJointEntity>[]
    stageTransformEvents: Ordered<StageTransformEventJointEntity>[]
}

const events = <T extends { beat: number }>(
    entities: readonly T[],
    track: (entity: T) => number,
    encode: (entity: T) => readonly RecordValue[],
): Ordered<T>[] =>
    sortEventRecords(
        entities.map((entity) => ({
            entity,
            key: entity.beat,
            track: track(entity),
            record: encode(entity),
        })),
    )

const stageHeads = <J>(ranges: Map<number, { min: J }>) =>
    [...ranges.values()].map(({ min }) => min)

/**
 * The store's entities in the order records list them: slides by first beat, then canonical
 * bytes; events by beat, then track, then chain order. Shared by `toRecords`, the level-data
 * serializer and the editor metadata, so all three agree.
 */
export const orderStore = (store: Store): OrderedStore => {
    const { grid, slides, globalEventRanges, stageEventRanges } = store
    return {
        slides: sortSlideRecords(
            [...slides.note]
                .filter(([, notes]) => notes.length)
                .map(([slideId, notes]) => ({
                    slideId,
                    entity: notes,
                    // Filtered to non-empty above.
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    key: notes[0]!.beat,
                    record: slideRecord(notes),
                })),
        ),
        bpms: events(entitiesOf(grid.bpm), () => 0, bpmRecord),
        timeScales: events(entitiesOf(grid.timeScale), (e) => e.groupId, timeScaleRecord),
        cameraEvents: events(
            inChainOrder(
                grid.cameraEventJoint,
                grid.cameraEventConnection,
                globalEventRanges.cameraEventJoint ? [globalEventRanges.cameraEventJoint.min] : [],
            ),
            () => 0,
            cameraEventRecord,
        ),
        stageMaskEvents: events(
            inChainOrder(
                grid.stageMaskEventJoint,
                grid.stageMaskEventConnection,
                stageHeads(stageEventRanges.stageMaskEventJoint),
            ),
            (e) => e.stageId,
            stageMaskEventRecord,
        ),
        stagePivotEvents: events(
            inChainOrder(
                grid.stagePivotEventJoint,
                grid.stagePivotEventConnection,
                stageHeads(stageEventRanges.stagePivotEventJoint),
            ),
            (e) => e.stageId,
            stagePivotEventRecord,
        ),
        stageStyleEvents: events(
            inChainOrder(
                grid.stageStyleEventJoint,
                grid.stageStyleEventConnection,
                stageHeads(stageEventRanges.stageStyleEventJoint),
            ),
            (e) => e.stageId,
            stageStyleEventRecord,
        ),
        stageTransformEvents: events(
            inChainOrder(
                grid.stageTransformEventJoint,
                grid.stageTransformEventConnection,
                stageHeads(stageEventRanges.stageTransformEventJoint),
            ),
            (e) => e.stageId,
            stageTransformEventRecord,
        ),
    }
}

export const noteObjectOf = (note: NoteEntity): NoteObject => ({
    groupId: note.groupId,
    stageId: note.stageId,
    beat: note.beat,
    elevation: note.elevation,
    noteStyle: note.noteStyle,
    connectorStyle: note.connectorStyle,
    noteType: note.noteType,
    isAttached: note.isAttached,
    left: note.left,
    size: note.size,
    isCritical: note.isCritical,
    flickDirection: note.flickDirection,
    isFake: note.isFake,
    sfx: note.sfx,
    isConnectorSeparator: note.isConnectorSeparator,
    connectorType: note.connectorType,
    connectorEase: note.connectorEase,
    connectorIsFake: note.connectorIsFake,
    connectorActiveIsCritical: note.connectorActiveIsCritical,
    connectorGuideAlpha: note.connectorGuideAlpha,
    connectorLayer: note.connectorLayer,
    connectorIsPassThrough: note.connectorIsPassThrough,
    connectorPresentation: note.connectorPresentation,
})

const entities = <T>(list: readonly Ordered<T>[]) => list.map(({ entity }) => entity)

/** The `Chart` a state holds (§1.6.2), every kind in the v1 order. */
export const extractChart = (state: State, ordered = orderStore(state.store)): Chart => ({
    initialLife: state.initialLife,
    isDynamicStages: state.isDynamicStages,
    bpms: entities(ordered.bpms).map(({ beat, bpm, meter }): BpmObject => ({ beat, bpm, meter })),
    groups: new Map(state.groups),
    stages: new Map(state.stages),
    groupFolders: new Map(state.groupFolders),
    stageFolders: new Map(state.stageFolders),
    cameraEvents: entities(ordered.cameraEvents).map((e): CameraEventObject => ({
        beat: e.beat,
        cameraLeft: e.cameraLeft,
        cameraSize: e.cameraSize,
        cameraZoom: e.cameraZoom,
        cameraZoomTargetLane: e.cameraZoomTargetLane,
        cameraZoomTargetY: e.cameraZoomTargetY,
        cameraZoomVerticalAlign: e.cameraZoomVerticalAlign,
        cameraRotation: e.cameraRotation,
        cameraStageTilt: e.cameraStageTilt,
        eventEase: e.eventEase,
    })),
    stageMaskEvents: entities(ordered.stageMaskEvents).map((e): StageMaskEventObject => ({
        stageId: e.stageId,
        beat: e.beat,
        maskLeft: e.maskLeft,
        maskSize: e.maskSize,
        isMaskNotes: e.isMaskNotes,
        eventEase: e.eventEase,
    })),
    stagePivotEvents: entities(ordered.stagePivotEvents).map((e): StagePivotEventObject => ({
        stageId: e.stageId,
        beat: e.beat,
        pivotLane: e.pivotLane,
        divisionSize: e.divisionSize,
        divisionParity: e.divisionParity,
        yOffset: e.yOffset,
        yOffsetBeat: e.yOffsetBeat,
        eventEase: e.eventEase,
    })),
    stageStyleEvents: entities(ordered.stageStyleEvents).map((e): StageStyleEventObject => ({
        stageId: e.stageId,
        beat: e.beat,
        editorLane: e.editorLane,
        judgmentLineColor: e.judgmentLineColor,
        judgmentLineStyle: e.judgmentLineStyle,
        leftBorderStyle: e.leftBorderStyle,
        rightBorderStyle: e.rightBorderStyle,
        isFullWidth: e.isFullWidth,
        noteAlpha: e.noteAlpha,
        laneAlpha: e.laneAlpha,
        judgmentLineAlpha: e.judgmentLineAlpha,
        divisionLineAlpha: e.divisionLineAlpha,
        eventEase: e.eventEase,
    })),
    stageTransformEvents: entities(ordered.stageTransformEvents).map(
        (e): StageTransformEventObject => ({
            stageId: e.stageId,
            beat: e.beat,
            rotation: e.rotation,
            xTranslation: e.xTranslation,
            yTranslation: e.yTranslation,
            elevation: e.elevation,
            anchor: e.anchor,
            eventEase: e.eventEase,
        }),
    ),
    timeScales: entities(ordered.timeScales).map((e): TimeScaleObject => ({
        groupId: e.groupId,
        beat: e.beat,
        editorLane: e.editorLane,
        timeScale: e.timeScale,
        skip: e.skip,
        timeScaleEase: e.timeScaleEase,
        timeScaleTransition: e.timeScaleTransition,
        hideNotes: e.hideNotes,
    })),
    // A slide's notes are kept sorted by rebuildSlide, same-beat notes in slide order.
    slides: entities(ordered.slides).map((notes) => notes.map(noteObjectOf)),
})
