import type { Chart } from '../../chart'
import type { BpmObject } from '../../chart/bpm'
import type { CameraEventObject } from '../../chart/events/camera'
import type { StageMaskEventObject } from '../../chart/events/stage/mask'
import type { StagePivotEventObject } from '../../chart/events/stage/pivot'
import type { StageStyleEventObject } from '../../chart/events/stage/style'
import type { StageTransformEventObject } from '../../chart/events/stage/transform'
import type { FolderId, Folders } from '../../chart/folders'
import type { GroupId, Groups } from '../../chart/groups'
import type { NoteObject } from '../../chart/note'
import type { StageId, Stages } from '../../chart/stages'
import type { TimeScaleObject } from '../../chart/timeScale'
import { createState, type State } from '../../state'
import type { BgmMeta } from '../../state/bgm'
import { emptyLevelInfo, type LevelInfo, type MediaRef } from '../../state/levelInfo'
import { canonical, type RecordValue } from './canonical'
import { extractChart } from './extract'
import { kindNames, type KindName } from './schema'

// Explicit positional encoders and decoders per record (§1.6.11.1), never `JSON.stringify`
// of a model object. `fields.test.ts` checks every position against `fields-v1.json`.

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
export const sortSlideRecords = (records: KeyedRecord[]): KeyedRecord[] =>
    records
        .map((item) => ({ item, text: canonical(item.record) }))
        .sort((a, b) => a.item.key - b.item.key || compareText(a.text, b.text))
        .map(({ item }) => item)

/** An event's place: its beat, its track (stage, or group for time scales; 0 for one track). */
export type EventPlace = { key: number; track: number; record: Rec }

/**
 * Events (and BPMs and time scales): by window key and beat, then track, then their order
 * along the track's chain, which is the input's order (D4: same-beat events play in chain
 * order, so a byte sort would change the chart).
 */
export const sortEventRecords = (records: readonly EventPlace[]): KeyedRecord[] =>
    records
        .map((item, index) => ({ item, index }))
        .sort((a, b) => a.item.key - b.item.key || a.item.track - b.item.track || a.index - b.index)
        .map(({ item }) => ({ key: item.key, record: item.record }))

const trackOf = (object: object) =>
    'stageId' in object
        ? (object.stageId as number)
        : 'groupId' in object
          ? (object.groupId as number)
          : 0

/** A chart's records in the v1 order: slides from the chart's slides, events in chain order per track. */
export const chartKindRecords = (chart: Chart): KindRecords[] => {
    const kinds: KindRecords[] = []
    for (const kind of kindNames) {
        let records: KeyedRecord[]
        if (kind === 'slides') {
            records = sortSlideRecords(
                chart.slides
                    .filter((slide) => slide.length)
                    // Filtered to non-empty above.
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    .map((slide) => ({ key: slide[0]!.beat, record: slideRecord(slide) })),
            )
        } else {
            const encode = kindEncoders[kind] as (object: object) => Rec
            records = sortEventRecords(
                (chart[kind] as (object & { beat: number })[]).map((object) => ({
                    key: object.beat,
                    track: trackOf(object),
                    record: encode(object),
                })),
            )
        }
        if (records.length) kinds.push({ kind, records })
    }
    return kinds
}

const optional = (value: RecordValue | undefined): Rec => (value === undefined ? [] : [value])

export const mediaRefRecord = (media: MediaRef | undefined): Rec =>
    media ? [media.hash, media.filename, media.size, media.type] : []

export const bgmRecord = (bgm: BgmMeta): Rec => [
    bgm.hash,
    bgm.filename,
    bgm.size,
    bgm.type,
    ...optional(bgm.durationMs),
]

export const levelInfoRecord = (info: LevelInfo): Rec => [
    info.title,
    info.artists,
    info.author,
    info.description,
    info.tags.map((tag) => [tag.title, ...optional(tag.icon)]),
    mediaRefRecord(info.cover),
    mediaRefRecord(info.preview),
    ...optional(info.rating),
]

const groupsRecord = (groups: Groups): Rec =>
    [...groups].map(([id, group]) => [
        id,
        group.name,
        group.forceNoteSpeed ?? 0,
        ...optional(group.folderId),
    ])

const stagesRecord = (stages: Stages): Rec =>
    [...stages].map(([id, stage]) => [
        id,
        stage.name,
        stage.isFromStart,
        stage.isUntilEnd,
        stage.generateSimLines,
        ...optional(stage.folderId),
    ])

const foldersRecord = (folders: Folders | undefined): Rec =>
    [...(folders ?? [])].map(([id, folder]) => [
        id,
        folder.name,
        folder.index,
        ...optional(folder.folderId),
    ])

/** What a header holds beside the chart (§1.6.2). */
export type HeaderExtras = { bgmOffset: number; levelInfo: LevelInfo; bgm?: BgmMeta }

export const headerRecord = (chart: Chart, extras: HeaderExtras): Rec => [
    chart.initialLife,
    chart.isDynamicStages,
    extras.bgmOffset,
    groupsRecord(chart.groups),
    stagesRecord(chart.stages),
    foldersRecord(chart.groupFolders),
    foldersRecord(chart.stageFolders),
    levelInfoRecord(extras.levelInfo),
    ...(extras.bgm ? [bgmRecord(extras.bgm)] : []),
]

export const chartToRecords = (chart: Chart, extras: HeaderExtras): SnapshotRecords => ({
    header: headerRecord(chart, extras),
    kinds: chartKindRecords(chart),
})

/** A state's records (§1.6.2): what a snapshot stores. */
export const toRecords = (state: State): SnapshotRecords =>
    chartToRecords(extractChart(state), {
        bgmOffset: state.bgm.offset,
        levelInfo: state.levelInfo,
        ...(state.bgm.meta ? { bgm: state.bgm.meta } : {}),
    })

/** What `createState` takes, from records. */
export type RecordsContent = {
    chart: Chart
    offset: number
    levelInfo: LevelInfo
    bgm?: BgmMeta
}

// Decoders assume records that passed the schema (`checkRecord`), so positions have their types.

const asNumber = (value: RecordValue | undefined) => value as number
const asString = (value: RecordValue | undefined) => value as string
const asBool = (value: RecordValue | undefined) => value as boolean
const asList = (value: RecordValue | undefined) => value as readonly Rec[]

export const noteObject = (r: Rec): NoteObject => ({
    groupId: asNumber(r[0]) as GroupId,
    stageId: asNumber(r[1]) as StageId,
    beat: asNumber(r[2]),
    elevation: asNumber(r[3]),
    noteStyle: asString(r[4]) as NoteObject['noteStyle'],
    connectorStyle: asString(r[5]) as NoteObject['connectorStyle'],
    noteType: asString(r[6]) as NoteObject['noteType'],
    isAttached: asBool(r[7]),
    left: asNumber(r[8]),
    size: asNumber(r[9]),
    isCritical: asBool(r[10]),
    flickDirection: asString(r[11]) as NoteObject['flickDirection'],
    isFake: asBool(r[12]),
    sfx: asString(r[13]) as NoteObject['sfx'],
    isConnectorSeparator: asBool(r[14]),
    connectorType: asString(r[15]) as NoteObject['connectorType'],
    connectorEase: asString(r[16]) as NoteObject['connectorEase'],
    connectorIsFake: asBool(r[17]),
    connectorActiveIsCritical: asBool(r[18]),
    connectorGuideAlpha: asNumber(r[19]),
    connectorLayer: asString(r[20]) as NoteObject['connectorLayer'],
    connectorIsPassThrough: asBool(r[21]),
    connectorPresentation: asString(r[22]) as NoteObject['connectorPresentation'],
})

export const bpmObject = (r: Rec): BpmObject => ({
    beat: asNumber(r[0]),
    bpm: asNumber(r[1]),
    meter: asNumber(r[2]),
})

export const timeScaleObject = (r: Rec): TimeScaleObject => ({
    groupId: asNumber(r[0]) as GroupId,
    beat: asNumber(r[1]),
    editorLane: asNumber(r[2]),
    timeScale: asNumber(r[3]),
    skip: asNumber(r[4]),
    timeScaleEase: asString(r[5]) as TimeScaleObject['timeScaleEase'],
    timeScaleTransition: asString(r[6]) as TimeScaleObject['timeScaleTransition'],
    hideNotes: asBool(r[7]),
})

export const cameraEventObject = (r: Rec): CameraEventObject => ({
    beat: asNumber(r[0]),
    cameraLeft: asNumber(r[1]),
    cameraSize: asNumber(r[2]),
    cameraZoom: asNumber(r[3]),
    cameraZoomTargetLane: asNumber(r[4]),
    cameraZoomTargetY: asNumber(r[5]),
    cameraZoomVerticalAlign: asString(r[6]) as CameraEventObject['cameraZoomVerticalAlign'],
    cameraRotation: asNumber(r[7]),
    cameraStageTilt: asNumber(r[8]),
    eventEase: asString(r[9]) as CameraEventObject['eventEase'],
})

export const stageMaskEventObject = (r: Rec): StageMaskEventObject => ({
    stageId: asNumber(r[0]) as StageId,
    beat: asNumber(r[1]),
    maskLeft: asNumber(r[2]),
    maskSize: asNumber(r[3]),
    isMaskNotes: asBool(r[4]),
    eventEase: asString(r[5]) as StageMaskEventObject['eventEase'],
})

export const stagePivotEventObject = (r: Rec): StagePivotEventObject => ({
    stageId: asNumber(r[0]) as StageId,
    beat: asNumber(r[1]),
    pivotLane: asNumber(r[2]),
    divisionSize: asNumber(r[3]),
    divisionParity: asString(r[4]) as StagePivotEventObject['divisionParity'],
    yOffset: asNumber(r[5]),
    yOffsetBeat: asNumber(r[6]),
    eventEase: asString(r[7]) as StagePivotEventObject['eventEase'],
})

export const stageStyleEventObject = (r: Rec): StageStyleEventObject => ({
    stageId: asNumber(r[0]) as StageId,
    beat: asNumber(r[1]),
    editorLane: asNumber(r[2]),
    judgmentLineColor: asString(r[3]) as StageStyleEventObject['judgmentLineColor'],
    judgmentLineStyle: asString(r[4]) as StageStyleEventObject['judgmentLineStyle'],
    leftBorderStyle: asString(r[5]) as StageStyleEventObject['leftBorderStyle'],
    rightBorderStyle: asString(r[6]) as StageStyleEventObject['rightBorderStyle'],
    isFullWidth: asBool(r[7]),
    noteAlpha: asNumber(r[8]),
    laneAlpha: asNumber(r[9]),
    judgmentLineAlpha: asNumber(r[10]),
    divisionLineAlpha: asNumber(r[11]),
    eventEase: asString(r[12]) as StageStyleEventObject['eventEase'],
})

export const stageTransformEventObject = (r: Rec): StageTransformEventObject => ({
    stageId: asNumber(r[0]) as StageId,
    beat: asNumber(r[1]),
    rotation: asNumber(r[2]),
    xTranslation: asNumber(r[3]),
    yTranslation: asNumber(r[4]),
    elevation: asNumber(r[5]),
    anchor: asString(r[6]) as StageTransformEventObject['anchor'],
    eventEase: asString(r[7]) as StageTransformEventObject['eventEase'],
})

const folderOf = (value: RecordValue | undefined) =>
    value === undefined ? {} : { folderId: value as FolderId }

const foldersObject = (records: readonly Rec[]): Folders =>
    new Map(
        records.map(([id, name, index, folderId]) => [
            id as FolderId,
            { name: asString(name), index: asNumber(index), ...folderOf(folderId) },
        ]),
    )

const mediaRefObject = (r: Rec): MediaRef | undefined =>
    r.length
        ? {
              hash: asString(r[0]),
              filename: asString(r[1]),
              size: asNumber(r[2]),
              type: asString(r[3]),
          }
        : undefined

export const levelInfoObject = (r: Rec): LevelInfo => {
    const cover = mediaRefObject(r[5] as Rec)
    const preview = mediaRefObject(r[6] as Rec)
    return {
        title: asString(r[0]),
        artists: asString(r[1]),
        author: asString(r[2]),
        description: asString(r[3]),
        tags: asList(r[4]).map((tag) => ({
            title: asString(tag[0]),
            ...(tag[1] === undefined ? {} : { icon: asString(tag[1]) }),
        })),
        ...(cover ? { cover } : {}),
        ...(preview ? { preview } : {}),
        ...(r[7] === undefined ? {} : { rating: asNumber(r[7]) }),
    }
}

export const bgmObject = (r: Rec): BgmMeta => ({
    hash: asString(r[0]),
    filename: asString(r[1]),
    size: asNumber(r[2]),
    type: asString(r[3]),
    ...(r[4] === undefined ? {} : { durationMs: asNumber(r[4]) }),
})

/** A chart and the rest of a state from records in the v1 order (§1.6.11.1). */
export const fromRecords = ({ header, kinds }: SnapshotRecords): RecordsContent => {
    const [initialLife, isDynamicStages, bgmOffset, groups, stages, groupFolders, stageFolders] =
        header
    const levelInfo = levelInfoObject(header[7] as Rec)
    const bgm = header[8] === undefined ? undefined : bgmObject(header[8] as Rec)

    const chart: Chart = {
        initialLife: asNumber(initialLife),
        isDynamicStages: asBool(isDynamicStages),
        bpms: [],
        groups: new Map(
            asList(groups).map(([id, name, forceNoteSpeed, folderId]) => [
                id as GroupId,
                {
                    name: asString(name),
                    // `0` is none, as the level-data serializer treats a falsy value.
                    ...(forceNoteSpeed ? { forceNoteSpeed: asNumber(forceNoteSpeed) } : {}),
                    ...folderOf(folderId),
                },
            ]),
        ),
        stages: new Map(
            asList(stages).map(
                ([id, name, isFromStart, isUntilEnd, generateSimLines, folderId]) => [
                    id as StageId,
                    {
                        name: asString(name),
                        isFromStart: asBool(isFromStart),
                        isUntilEnd: asBool(isUntilEnd),
                        generateSimLines: asString(generateSimLines) as 'global' | 'isolated',
                        ...folderOf(folderId),
                    },
                ],
            ),
        ),
        groupFolders: foldersObject(asList(groupFolders)),
        stageFolders: foldersObject(asList(stageFolders)),
        cameraEvents: [],
        stageMaskEvents: [],
        stagePivotEvents: [],
        stageStyleEvents: [],
        stageTransformEvents: [],
        timeScales: [],
        slides: [],
    }

    for (const { kind, records } of kinds) {
        const list = records.map(({ record }) => record)
        switch (kind) {
            case 'slides':
                chart.slides = list.map((slide) => (slide as readonly Rec[]).map(noteObject))
                break
            case 'bpms':
                chart.bpms = list.map(bpmObject)
                break
            case 'timeScales':
                chart.timeScales = list.map(timeScaleObject)
                break
            case 'cameraEvents':
                chart.cameraEvents = list.map(cameraEventObject)
                break
            case 'stageMaskEvents':
                chart.stageMaskEvents = list.map(stageMaskEventObject)
                break
            case 'stagePivotEvents':
                chart.stagePivotEvents = list.map(stagePivotEventObject)
                break
            case 'stageStyleEvents':
                chart.stageStyleEvents = list.map(stageStyleEventObject)
                break
            case 'stageTransformEvents':
                chart.stageTransformEvents = list.map(stageTransformEventObject)
                break
        }
    }

    return {
        chart,
        offset: asNumber(bgmOffset),
        levelInfo: isEmptyLevelInfo(levelInfo) ? emptyLevelInfo : levelInfo,
        ...(bgm ? { bgm } : {}),
    }
}

const isEmptyLevelInfo = (info: LevelInfo) =>
    !info.title &&
    !info.artists &&
    !info.author &&
    !info.description &&
    !info.tags.length &&
    !info.cover &&
    !info.preview &&
    info.rating === undefined

/** A state from records: `createState(fromRecords(r))`. */
export const stateFromRecords = (records: SnapshotRecords): State => {
    const { chart, offset, levelInfo, bgm } = fromRecords(records)
    return createState(chart, offset, { levelInfo, ...(bgm ? { bgm } : {}) })
}

/** Every note record in a snapshot's slides: the root's `noteCount`. */
export const noteCountOf = (kinds: readonly KindRecords[]) =>
    kinds
        .filter(({ kind }) => kind === 'slides')
        .reduce(
            (count, { records }) => records.reduce((sum, { record }) => sum + record.length, count),
            0,
        )
