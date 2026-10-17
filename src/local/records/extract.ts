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
import type { NoteEntity } from '../../state/entities/slides/note'

/** Every entity of a grid once, in bucket order; joints sit in one bucket each. */
const entitiesOf = <T>(grid: Map<number, Set<T>>) => {
    const entities = new Set<T>()
    for (const bucket of grid.values()) for (const entity of bucket) entities.add(entity)
    return [...entities]
}

/**
 * A track's joints in chain order: same-beat joints are ordered by their chain,
 * which playback follows, and buckets don't keep it. A joint no chain reaches still comes out.
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

/** The `Chart` a state holds (§1.6.2), events in chain order per track; `toRecords` sorts it. */
export const extractChart = (state: State): Chart => {
    const { grid, slides, globalEventRanges, stageEventRanges } = state.store
    return {
        initialLife: state.initialLife,
        isDynamicStages: state.isDynamicStages,
        bpms: entitiesOf(grid.bpm).map(({ beat, bpm, meter }): BpmObject => ({ beat, bpm, meter })),
        groups: new Map(state.groups),
        stages: new Map(state.stages),
        groupFolders: new Map(state.groupFolders),
        stageFolders: new Map(state.stageFolders),
        cameraEvents: inChainOrder(
            grid.cameraEventJoint,
            grid.cameraEventConnection,
            globalEventRanges.cameraEventJoint ? [globalEventRanges.cameraEventJoint.min] : [],
        ).map((e): CameraEventObject => ({
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
        stageMaskEvents: inChainOrder(
            grid.stageMaskEventJoint,
            grid.stageMaskEventConnection,
            [...stageEventRanges.stageMaskEventJoint.values()].map(({ min }) => min),
        ).map((e): StageMaskEventObject => ({
            stageId: e.stageId,
            beat: e.beat,
            maskLeft: e.maskLeft,
            maskSize: e.maskSize,
            isMaskNotes: e.isMaskNotes,
            eventEase: e.eventEase,
        })),
        stagePivotEvents: inChainOrder(
            grid.stagePivotEventJoint,
            grid.stagePivotEventConnection,
            [...stageEventRanges.stagePivotEventJoint.values()].map(({ min }) => min),
        ).map((e): StagePivotEventObject => ({
            stageId: e.stageId,
            beat: e.beat,
            pivotLane: e.pivotLane,
            divisionSize: e.divisionSize,
            divisionParity: e.divisionParity,
            yOffset: e.yOffset,
            yOffsetBeat: e.yOffsetBeat,
            eventEase: e.eventEase,
        })),
        stageStyleEvents: inChainOrder(
            grid.stageStyleEventJoint,
            grid.stageStyleEventConnection,
            [...stageEventRanges.stageStyleEventJoint.values()].map(({ min }) => min),
        ).map((e): StageStyleEventObject => ({
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
        stageTransformEvents: inChainOrder(
            grid.stageTransformEventJoint,
            grid.stageTransformEventConnection,
            [...stageEventRanges.stageTransformEventJoint.values()].map(({ min }) => min),
        ).map((e): StageTransformEventObject => ({
            stageId: e.stageId,
            beat: e.beat,
            rotation: e.rotation,
            xTranslation: e.xTranslation,
            yTranslation: e.yTranslation,
            elevation: e.elevation,
            anchor: e.anchor,
            eventEase: e.eventEase,
        })),
        timeScales: entitiesOf(grid.timeScale).map((e): TimeScaleObject => ({
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
        slides: [...slides.note.values()]
            .filter((notes) => notes.length)
            .map((notes) => notes.map(noteObjectOf)),
    }
}
