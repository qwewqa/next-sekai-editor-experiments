import type { Chart } from '../../src/chart'
import type { GroupId } from '../../src/chart/groups'
import { parseLevelDataChart } from '../../src/chart/parse/levelData'
import type { StageId } from '../../src/chart/stages'
import { serializeEditorMetadata } from '../../src/levelData/editorMetadata'
import { serializeToLevelData } from '../../src/levelData/serialize'
import { fromRecords, stateFromRecords, toRecords } from '../../src/local/records/records'
import { createState, type State } from '../../src/state'
import type { Entity } from '../../src/state/entities'
import { addBpm, removeBpm } from '../../src/state/mutations/bpm'
import {
    addCameraEventJoint,
    removeCameraEventJoint,
} from '../../src/state/mutations/events/camera'
import {
    addStageMaskEventJoint,
    removeStageMaskEventJoint,
} from '../../src/state/mutations/events/stage/mask'
import {
    addStagePivotEventJoint,
    removeStagePivotEventJoint,
} from '../../src/state/mutations/events/stage/pivot'
import {
    addStageStyleEventJoint,
    removeStageStyleEventJoint,
} from '../../src/state/mutations/events/stage/style'
import {
    addStageTransformEventJoint,
    removeStageTransformEventJoint,
} from '../../src/state/mutations/events/stage/transform'
import { addTimeScale, removeTimeScale } from '../../src/state/mutations/timeScale'
import type { EditableProperties } from '../../src/state/operations/editable'
import { createTransaction, type Transaction } from '../../src/state/transaction'
import { stateOrderDifferences } from '../local/records/stateOrder'

// Every kind whose same-beat order is state: each event kind, time scales and BPMs. Each
// object carries a tag in one field, so an order reads as a list of tags.

export const stageId = (id: number) => id as StageId
export const groupId = (id: number) => id as GroupId

/** A chart with dynamic stages, two groups, two stages and one BPM at beat 0. */
export const baseChart = (): Chart => ({
    initialLife: 1000,
    isDynamicStages: true,
    bpms: [{ beat: 0, bpm: 120, meter: 4 }],
    groups: new Map([
        [groupId(1), { name: 'One' }],
        [groupId(2), { name: 'Two' }],
    ]),
    stages: new Map([
        [
            stageId(1),
            { name: 'One', isFromStart: true, isUntilEnd: true, generateSimLines: 'global' },
        ],
        [
            stageId(2),
            { name: 'Two', isFromStart: true, isUntilEnd: true, generateSimLines: 'global' },
        ],
    ]),
    cameraEvents: [],
    stageMaskEvents: [],
    stagePivotEvents: [],
    stageStyleEvents: [],
    stageTransformEvents: [],
    timeScales: [],
    slides: [],
})

export const baseState = () => createState(baseChart(), 0)

export type Tagged = { beat: number; stageId?: number; groupId?: number } & Record<string, unknown>

type Mutation = (transaction: Transaction, object: never) => Entity[] | void

export type Kind = {
    name: string
    type: Entity['type']
    chart: Exclude<keyof Chart, 'initialLife' | 'isDynamicStages' | 'groups' | 'stages'>
    /** The object with the tag at the beat on the track (a stage, a group, or none). */
    make: (beat: number, tag: number, track: number) => Tagged
    add: Mutation
    remove: Mutation
    /** An edit to another field, which keeps the object's place. */
    edit: EditableProperties
    /** Its track's id field, when it has tracks. */
    track?: 'stageId' | 'groupId'
    /** The field holding the tag. */
    field: string
}

export const kinds: Kind[] = [
    {
        name: 'camera',
        type: 'cameraEventJoint',
        chart: 'cameraEvents',
        field: 'cameraLeft',
        make: (beat, tag) => ({
            beat,
            cameraLeft: tag,
            cameraSize: 12,
            cameraZoom: 1,
            cameraZoomTargetLane: 0,
            cameraZoomTargetY: 0,
            cameraZoomVerticalAlign: 'default',
            cameraRotation: 0,
            cameraStageTilt: 0,
            eventEase: 'linear',
        }),
        add: addCameraEventJoint,
        remove: removeCameraEventJoint,
        edit: { cameraZoom: 2 },
    },
    {
        name: 'mask',
        type: 'stageMaskEventJoint',
        chart: 'stageMaskEvents',
        field: 'maskLeft',
        make: (beat, tag, track) => ({
            stageId: track,
            beat,
            maskLeft: tag,
            maskSize: 4,
            isMaskNotes: false,
            eventEase: 'linear',
        }),
        add: addStageMaskEventJoint,
        remove: removeStageMaskEventJoint,
        edit: { isMaskNotes: true },
        track: 'stageId',
    },
    {
        name: 'pivot',
        type: 'stagePivotEventJoint',
        chart: 'stagePivotEvents',
        field: 'pivotLane',
        make: (beat, tag, track) => ({
            stageId: track,
            beat,
            pivotLane: tag,
            divisionSize: 2,
            divisionParity: 'even',
            yOffset: 0,
            yOffsetBeat: 0,
            eventEase: 'linear',
        }),
        add: addStagePivotEventJoint,
        remove: removeStagePivotEventJoint,
        edit: { divisionSize: 3 },
        track: 'stageId',
    },
    {
        name: 'style',
        type: 'stageStyleEventJoint',
        chart: 'stageStyleEvents',
        field: 'editorLane',
        make: (beat, tag, track) => ({
            stageId: track,
            beat,
            editorLane: tag,
            laneColor: 'default',
            judgmentLineColor: 'neutral',
            judgmentLineStyle: 'default',
            leftBorderStyle: 'default',
            rightBorderStyle: 'default',
            isFullWidth: false,
            noteAlpha: 1,
            laneAlpha: 1,
            judgmentLineAlpha: 1,
            divisionLineAlpha: 1,
            eventEase: 'linear',
        }),
        add: addStageStyleEventJoint,
        remove: removeStageStyleEventJoint,
        edit: { laneAlpha: 0.5 },
        track: 'stageId',
    },
    {
        name: 'transform',
        type: 'stageTransformEventJoint',
        chart: 'stageTransformEvents',
        field: 'xTranslation',
        make: (beat, tag, track) => ({
            stageId: track,
            beat,
            rotation: 0,
            xTranslation: tag,
            yTranslation: 0,
            elevation: 0,
            anchor: 'default',
            eventEase: 'linear',
        }),
        add: addStageTransformEventJoint,
        remove: removeStageTransformEventJoint,
        edit: { rotation: 10 },
        track: 'stageId',
    },
    {
        name: 'time scale',
        type: 'timeScale',
        chart: 'timeScales',
        field: 'timeScale',
        make: (beat, tag, track) => ({
            groupId: track,
            beat,
            editorLane: -6,
            timeScale: tag,
            skip: 0,
            timeScaleEase: 'none',
            timeScaleTransition: 'timeScale',
            hideNotes: false,
        }),
        add: addTimeScale,
        remove: removeTimeScale,
        edit: { skip: 1 },
        track: 'groupId',
    },
    {
        name: 'BPM',
        type: 'bpm',
        chart: 'bpms',
        field: 'bpm',
        // A BPM's tag is its BPM less 100.
        make: (beat, tag) => ({ beat, bpm: 100 + tag, meter: 4 }),
        add: addBpm,
        remove: removeBpm,
        edit: { meter: 3 },
    },
]

const tagOf = (kind: Kind, object: Tagged) =>
    (object[kind.field] as number) - (kind.type === 'bpm' ? 100 : 0)

const onTrack = (kind: Kind, object: Tagged, track: number) =>
    !kind.track || object[kind.track] === track

/** Adds the kind's object with the tag at the beat on the track. */
export const add = (transaction: Transaction, kind: Kind, beat: number, tag: number, track = 1) =>
    kind.add(transaction, kind.make(beat, tag, track) as never) ?? []

/** The kind's objects at the beat on the track, in the grid's order sorted by beat. */
export const entitiesAt = (state: State, kind: Kind, beat: number, track = 1) => {
    const entities = new Set<Entity>()
    for (const bucket of state.store.grid[kind.type].values())
        for (const entity of bucket) entities.add(entity as Entity)
    return [...entities]
        .sort((a, b) => a.beat - b.beat)
        .filter((entity) => entity.beat === beat && onTrack(kind, entity as never, track))
}

/** The entity with the tag at the beat on the track. */
export const entityAt = (state: State, kind: Kind, beat: number, tag: number, track = 1) => {
    const entity = entitiesAt(state, kind, beat, track).find(
        (entity) => tagOf(kind, entity as never) === tag,
    )
    if (!entity) throw new Error(`No ${kind.name} ${tag} at ${beat}`)
    return entity
}

/**
 * The order a state plays the kind's objects at a beat, as the editor shows it: the grid's
 * order, after checking it agrees with every chain and with the BPM integrals.
 */
export const seen = (state: State, kind: Kind, beat: number, track = 1) => {
    const differences = stateOrderDifferences(state)
    if (differences.length) throw new Error(differences.join('; '))
    return entitiesAt(state, kind, beat, track).map((entity) => tagOf(kind, entity as never))
}

/** The order of a chart's objects at a beat, as listed. */
export const chartOrder = (chart: Chart, kind: Kind, beat: number, track = 1) =>
    (chart[kind.chart] as Tagged[])
        .filter((object) => object.beat === beat && onTrack(kind, object, track))
        .map((object) => tagOf(kind, object))

/** The state's level data, as Export, the auto save and the journal write it. */
export const levelDataOf = (state: State) =>
    serializeToLevelData(
        state.initialLife,
        state.isDynamicStages,
        state.bgm.offset,
        state.store,
        state.groups,
        state.stages,
        { groups: state.groupFolders, stages: state.stageFolders },
    )

/** A state opened from level data, with its editor metadata. */
export const openLevelData = (
    entities: Parameters<typeof parseLevelDataChart>[0],
    bgmOffset: number,
    defaultGuideColors?: number[],
) => createState(parseLevelDataChart(entities, defaultGuideColors), bgmOffset)

/** A track's id in another state: level data numbers stages and groups afresh, in order. */
export const sameTrack = (kind: Kind, from: State, to: State, track: number) => {
    if (!kind.track) return track
    const ids = (state: State) => [
        ...(kind.track === 'groupId' ? state.groups : state.stages).keys(),
    ]
    return ids(to)[ids(from).indexOf(track as never)] as number
}

/**
 * The order seen at a beat, and what the records, a records round trip and a level-data round
 * trip keep of it: all four must be equal.
 */
export const keptOrders = (state: State, kind: Kind, beat: number, track = 1) => {
    const levelData = levelDataOf(state)
    const reopened = openLevelData(
        levelData.entities,
        levelData.bgmOffset,
        serializeEditorMetadata(levelData.entities, state.store).defaultGuideColors,
    )
    return {
        seen: seen(state, kind, beat, track),
        records: chartOrder(fromRecords(toRecords(state)).chart, kind, beat, track),
        restored: seen(stateFromRecords(toRecords(state)), kind, beat, track),
        levelData: seen(reopened, kind, beat, sameTrack(kind, state, reopened, track)),
    }
}

/** Runs each change in a transaction of its own, as separate user edits are. */
export const edits = (state: State, ...changes: ((transaction: Transaction) => unknown)[]) =>
    changes.reduce((current, change) => {
        const transaction = createTransaction(current)
        change(transaction)
        return transaction.commit([])
    }, state)
