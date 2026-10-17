import type { LevelDataEntity } from '@sonolus/core'
import type { Chart } from '../../chart'
import type { FolderId, Folders } from '../../chart/folders'
import type { GroupId } from '../../chart/groups'
import { parseLevelDataChart } from '../../chart/parse/levelData'
import type { StageId } from '../../chart/stages'
import { serializeEditorMetadata } from '../../levelData/editorMetadata'
import { serializeToLevelData } from '../../levelData/serialize'
import type { State } from '../../state'
import { emptyLevelInfo } from '../../state/levelInfo'
import { canonical } from './canonical'
import { chartToRecords, type SnapshotRecords } from './records'

// "`level.json` matches a state" (§1.6.11.6): both sides through the same level-data path,
// renumbered, then compared as records, the header's level info and BGM left out.

/**
 * Groups and stages get ids 1…n by their place in their map, and folders one sequence 1…n
 * across both folder maps, group folders first; every reference follows. Done before the
 * records are sorted, since ids decide the events' track order.
 */
export const renumberChart = (chart: Chart): Chart => {
    const numbering = <K>(map: ReadonlyMap<K, unknown> | undefined, from = 1) =>
        new Map([...(map ?? [])].map(([id], i) => [id, from + i]))
    const groupIds = numbering(chart.groups)
    const stageIds = numbering(chart.stages)
    const groupFolderIds = numbering(chart.groupFolders)
    const stageFolderIds = numbering(chart.stageFolders, groupFolderIds.size + 1)

    const map = <K>(ids: Map<K, number>, id: K) => {
        const mapped = ids.get(id)
        if (mapped === undefined) throw new Error(`Unexpected missing id ${String(id)}`)
        return mapped
    }
    // A link to a missing folder counts as none, as the folder tree reads it.
    const withFolder = <T extends { folderId?: FolderId }>(
        ids: Map<FolderId, number>,
        value: T,
    ): T => {
        if (value.folderId === undefined) return value
        const mapped = ids.get(value.folderId)
        if (mapped !== undefined) return { ...value, folderId: mapped as FolderId }
        const { folderId: _, ...rest } = value
        return rest as T
    }
    const folders = (ids: Map<FolderId, number>, source?: Folders): Folders =>
        new Map(
            [...(source ?? [])].map(([id, folder]) => [
                map(ids, id) as FolderId,
                withFolder(ids, folder),
            ]),
        )
    const group = (id: GroupId) => map(groupIds, id) as GroupId
    const stage = (id: StageId) => map(stageIds, id) as StageId

    return {
        ...chart,
        groups: new Map(
            [...chart.groups].map(([id, value]) => [group(id), withFolder(groupFolderIds, value)]),
        ),
        stages: new Map(
            [...chart.stages].map(([id, value]) => [stage(id), withFolder(stageFolderIds, value)]),
        ),
        groupFolders: folders(groupFolderIds, chart.groupFolders),
        stageFolders: folders(stageFolderIds, chart.stageFolders),
        timeScales: chart.timeScales.map((e) => ({ ...e, groupId: group(e.groupId) })),
        stageMaskEvents: chart.stageMaskEvents.map((e) => ({ ...e, stageId: stage(e.stageId) })),
        stagePivotEvents: chart.stagePivotEvents.map((e) => ({ ...e, stageId: stage(e.stageId) })),
        stageStyleEvents: chart.stageStyleEvents.map((e) => ({ ...e, stageId: stage(e.stageId) })),
        stageTransformEvents: chart.stageTransformEvents.map((e) => ({
            ...e,
            stageId: stage(e.stageId),
        })),
        slides: chart.slides.map((slide) =>
            slide.map((note) => ({
                ...note,
                groupId: group(note.groupId),
                stageId: stage(note.stageId),
            })),
        ),
    }
}

/** A chart's normalised records: renumbered, then in the v1 order, level info and BGM left out. */
export const normalisedRecords = (chart: Chart, bgmOffset: number): SnapshotRecords => {
    const { header, kinds } = chartToRecords(renumberChart(chart), {
        bgmOffset,
        levelInfo: emptyLevelInfo,
    })
    return { header: header.slice(0, 7), kinds }
}

/** A `level.json`'s normalised records, with `project.json`'s default guide colours when it has them. */
export const levelDataRecords = (
    entities: LevelDataEntity[],
    bgmOffset: number,
    defaultGuideColors?: readonly number[],
) => normalisedRecords(parseLevelDataChart(entities, defaultGuideColors), bgmOffset)

/** A state's normalised records, from the serializer's own output and its editor metadata. */
export const stateLevelDataRecords = (state: State) => {
    const levelData = serializeToLevelData(
        state.initialLife,
        state.isDynamicStages,
        state.bgm.offset,
        state.store,
        state.groups,
        state.stages,
        { groups: state.groupFolders, stages: state.stageFolders },
    )
    const { defaultGuideColors } = serializeEditorMetadata(levelData.entities, state.store)
    return levelDataRecords(levelData.entities, levelData.bgmOffset, defaultGuideColors)
}

/** Normalised records as one canonical text: two match when their texts are equal. */
export const normalisedText = ({ header, kinds }: SnapshotRecords) =>
    canonical([
        header,
        kinds.map(({ kind, records }) => [kind, records.map(({ record }) => record)]),
    ])

/** Whether a `level.json` matches a state (§1.6.11.6). */
export const levelDataMatchesState = (
    entities: LevelDataEntity[],
    bgmOffset: number,
    defaultGuideColors: readonly number[] | undefined,
    state: State,
) =>
    normalisedText(levelDataRecords(entities, bgmOffset, defaultGuideColors)) ===
    normalisedText(stateLevelDataRecords(state))
