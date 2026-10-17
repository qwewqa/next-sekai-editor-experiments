import type { BpmObject } from '../../chart/bpm'
import type { CameraEventObject } from '../../chart/events/camera'
import type { StageMaskEventObject } from '../../chart/events/stage/mask'
import type { StagePivotEventObject } from '../../chart/events/stage/pivot'
import type { StageStyleEventObject } from '../../chart/events/stage/style'
import type { StageTransformEventObject } from '../../chart/events/stage/transform'
import type { NoteObject } from '../../chart/note'
import type { TimeScaleObject } from '../../chart/timeScale'
import { canonical, type RecordValue } from './canonical'
import type { KindName } from './schema'

// Explicit positional encoders per record (§1.6.11.1), never `JSON.stringify` of a model
// object, and the v1 order. `fields.test.ts` checks every position against `fields-v1.json`.

type Rec = readonly RecordValue[]

export const noteRecord = (n: NoteObject): Rec => [
    n.groupId,
    n.stageId,
    n.beat,
    n.elevation ?? 0,
    n.noteStyle,
    n.connectorStyle,
    n.noteType,
    n.isAttached,
    n.left,
    n.size,
    n.isCritical,
    n.flickDirection,
    n.isFake,
    n.sfx,
    n.isConnectorSeparator,
    n.connectorType,
    n.connectorEase,
    n.connectorIsFake,
    n.connectorActiveIsCritical,
    n.connectorGuideAlpha,
    n.connectorLayer,
    n.connectorIsPassThrough,
    n.connectorPresentation,
]

export const slideRecord = (notes: readonly NoteObject[]): Rec => notes.map(noteRecord)

export const bpmRecord = (e: BpmObject): Rec => [e.beat, e.bpm, e.meter ?? 4]

export const timeScaleRecord = (e: TimeScaleObject): Rec => [
    e.groupId,
    e.beat,
    e.editorLane,
    e.timeScale,
    e.skip,
    e.timeScaleEase,
    e.timeScaleTransition,
    e.hideNotes,
]

export const cameraEventRecord = (e: CameraEventObject): Rec => [
    e.beat,
    e.cameraLeft,
    e.cameraSize,
    e.cameraZoom,
    e.cameraZoomTargetLane,
    e.cameraZoomTargetY,
    e.cameraZoomVerticalAlign,
    e.cameraRotation,
    e.cameraStageTilt,
    e.eventEase,
]

export const stageMaskEventRecord = (e: StageMaskEventObject): Rec => [
    e.stageId,
    e.beat,
    e.maskLeft,
    e.maskSize,
    e.isMaskNotes,
    e.eventEase,
]

export const stagePivotEventRecord = (e: StagePivotEventObject): Rec => [
    e.stageId,
    e.beat,
    e.pivotLane,
    e.divisionSize,
    e.divisionParity,
    e.yOffset,
    e.yOffsetBeat,
    e.eventEase,
]

export const stageStyleEventRecord = (e: StageStyleEventObject): Rec => [
    e.stageId,
    e.beat,
    e.editorLane,
    e.judgmentLineColor,
    e.judgmentLineStyle,
    e.leftBorderStyle,
    e.rightBorderStyle,
    e.isFullWidth,
    e.noteAlpha,
    e.laneAlpha,
    e.judgmentLineAlpha,
    e.divisionLineAlpha,
    e.eventEase,
]

export const stageTransformEventRecord = (e: StageTransformEventObject): Rec => [
    e.stageId,
    e.beat,
    e.rotation,
    e.xTranslation,
    e.yTranslation,
    e.elevation,
    e.anchor,
    e.eventEase,
]

/** Each kind's model object, and its record encoder. */
type KindObjects = {
    slides: NoteObject[]
    bpms: BpmObject
    timeScales: TimeScaleObject
    cameraEvents: CameraEventObject
    stageMaskEvents: StageMaskEventObject
    stagePivotEvents: StagePivotEventObject
    stageStyleEvents: StageStyleEventObject
    stageTransformEvents: StageTransformEventObject
}

export const kindEncoders: { [K in KindName]: (object: KindObjects[K]) => Rec } = {
    slides: slideRecord,
    bpms: bpmRecord,
    timeScales: timeScaleRecord,
    cameraEvents: cameraEventRecord,
    stageMaskEvents: stageMaskEventRecord,
    stagePivotEvents: stagePivotEventRecord,
    stageStyleEvents: stageStyleEventRecord,
    stageTransformEvents: stageTransformEventRecord,
}

/** A record and its window key: a slide's first beat, or an event's beat. */
export type KeyedRecord = { key: number; record: Rec }

/** Where each kind's records hold the window key's beat. */
const beatPositions: Record<Exclude<KindName, 'slides'>, number> = {
    bpms: 0,
    timeScales: 1,
    cameraEvents: 0,
    stageMaskEvents: 1,
    stagePivotEvents: 1,
    stageStyleEvents: 1,
    stageTransformEvents: 1,
}

/** A record's window key (§1.6.11.1): a slide's first note's beat, or the record's beat. */
export const recordKey = (kind: KindName, record: Rec) =>
    (kind === 'slides' ? (record[0] as Rec)[2] : record[beatPositions[kind]]) as number

/** A kind's records in the v1 order (§1.6.11.1), keyed for the split. */
export type KindRecords = { kind: KindName; records: KeyedRecord[] }

/**
 * A snapshot's records before the split: the header chunk's record and each kind that has
 * records, in the v1 kind order.
 */
export type SnapshotRecords = { header: Rec; kinds: KindRecords[] }

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Slides: by window key, then canonical bytes (UTF-16 code units, which is byte order for
 * these ASCII records), a total order. A slide's own note order is never touched.
 */
export const sortSlideRecords = <T extends KeyedRecord>(records: readonly T[]): T[] => {
    const items = records.map((item) => ({ item, text: undefined as string | undefined }))
    // Text only for slides that share a key: the encoder checks every record when it hashes.
    const textOf = (entry: (typeof items)[number]) => (entry.text ??= canonical(entry.item.record))
    return items
        .sort((a, b) => a.item.key - b.item.key || compareText(textOf(a), textOf(b)))
        .map(({ item }) => item)
}

/** An event's place: its beat, its track (stage, or group for time scales; 0 for one track). */
export type EventPlace = { key: number; track: number; record: Rec }

/**
 * Events (and BPMs and time scales): by window key and beat, then track, then their order
 * along the track's chain, which is the input's order (D4: same-beat events play in chain
 * order, so a byte sort would change the chart).
 */
export const sortEventRecords = <T extends EventPlace>(records: readonly T[]): T[] =>
    records
        .map((item, index) => ({ item, index }))
        .sort((a, b) => a.item.key - b.item.key || a.item.track - b.item.track || a.index - b.index)
        .map(({ item }) => item)
