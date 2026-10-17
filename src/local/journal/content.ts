import type { LevelData } from '@sonolus/core'
import { gzip, ungzip } from 'pako'
import type { Chart } from '../../chart'
import type { FolderId, Folders } from '../../chart/folders'
import type { GroupId, Groups } from '../../chart/groups'
import { parseLevelDataChart } from '../../chart/parse/levelData'
import type { StageId, Stages } from '../../chart/stages'
import { validateChart } from '../../chart/validate'
import { serializeEditorMetadata } from '../../levelData/editorMetadata'
import { restoreNullSegmentAlphas } from '../../levelData/parse'
import { LevelDataReport } from '../../levelData/report'
import { serializeToLevelData } from '../../levelData/serialize'
import { createState, type State } from '../../state'
import type { RecordValue } from '../records/canonical'
import { bgmObject, bgmRecord, levelInfoObject, levelInfoRecord } from '../records/records'
import type { JournalIds, JournalV1 } from './format'

// The journal's whole state (§1.6.4 #7, §1.6.11.3): level data gzipped on its own at level 1,
// so a recovery file needs no parsing, plus what level data can't carry: the header's level info
// and BGM records and every group, stage and folder id. Replay parses the level data and gives
// each entry its id back, so the recovered state hashes as the stack around it does wherever its
// values survive level data.

const toBase64 = (bytes: Uint8Array) => {
    const parts: string[] = []
    for (let at = 0; at < bytes.length; at += 0x8000)
        parts.push(String.fromCharCode(...bytes.subarray(at, at + 0x8000)))
    return btoa(parts.join(''))
}

const fromBase64 = (text: string) => {
    const binary = atob(text)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
}

/** A state's ids in level-data entity order: stage folders and stages as level data has them. */
export const idsOf = (state: State): JournalIds => ({
    groups: [...state.groups.keys()],
    // Without dynamic stages level data has no stages; the parser adds the default one.
    stages: [...state.stages.keys()],
    groupFolders: [...state.groupFolders.keys()],
    stageFolders: state.isDynamicStages ? [...state.stageFolders.keys()] : [],
})

/** The journal's state fields: `levelDataGz`, `editorMetadata` and `header`. */
export const journalContent = (
    state: State,
): Pick<JournalV1, 'levelDataGz' | 'editorMetadata' | 'header'> => {
    const levelData = serializeToLevelData(
        state.initialLife,
        state.isDynamicStages,
        state.bgm.offset,
        state.store,
        state.groups,
        state.stages,
        { groups: state.groupFolders, stages: state.stageFolders },
    )
    const levelDataGz = toBase64(gzip(JSON.stringify(levelData), { level: 1 }))
    const editorMetadata = serializeEditorMetadata(levelData.entities, state.store)
    return {
        levelDataGz,
        ...(editorMetadata.defaultGuideColors ? { editorMetadata } : {}),
        header: {
            levelInfo: levelInfoRecord(state.levelInfo) as unknown[],
            ...(state.bgm.meta ? { bgm: bgmRecord(state.bgm.meta) as unknown[] } : {}),
            ids: idsOf(state),
        },
    }
}

/** The level data a journal holds: a valid `.nsld` once decoded. */
export const journalLevelData = (journal: Pick<JournalV1, 'levelDataGz'>): LevelData =>
    JSON.parse(new TextDecoder().decode(ungzip(fromBase64(journal.levelDataGz)))) as LevelData

/**
 * The level data's shape, which the parser's own per-field checks rely on. Lighter than the
 * whole schema, which takes most of replay's time on a large chart: the parser checks each
 * value it reads, and anything it refuses makes the journal unreadable.
 */
const checkShape = (data: LevelData) => {
    if (
        typeof data !== 'object' ||
        typeof data.bgmOffset !== 'number' ||
        !Array.isArray(data.entities)
    )
        throw new Error('Not level data')
    for (const entity of data.entities as unknown[]) {
        const { archetype, data: fields, name } = (entity ?? {}) as Record<string, unknown>
        if (typeof archetype !== 'string' || !Array.isArray(fields))
            throw new Error('Not an entity')
        if (name !== undefined && typeof name !== 'string') throw new Error('Not an entity name')
        for (const field of fields as unknown[]) {
            const { name: key, value, ref } = (field ?? {}) as Record<string, unknown>
            if (typeof key !== 'string') throw new Error('Not an entity field')
            if (!(typeof value === 'number' || value === null || typeof ref === 'string'))
                throw new Error('Not an entity field value')
        }
    }
    restoreNullSegmentAlphas(data)
}

/** Ids in creation order: the parser numbers groups, stages and folders as it meets them. */
const ascending = <K extends number>(map: ReadonlyMap<K, unknown>) =>
    [...map.keys()].sort((a, b) => a - b)

const distinct = (ids: readonly number[]) => new Set(ids).size === ids.length

/**
 * The chart with the journal's ids (§1.6.11.3): the entry the parser made n-th takes the n-th id.
 * Groups, stages and folders (both maps, one id space) each keep theirs only when the counts
 * match the parsed level and the ids can be used; otherwise they keep the parser's fresh ids
 * (r11g-format M6), as stages do when level data has none.
 */
export const withJournalIds = (chart: Chart, ids: JournalIds): { chart: Chart; all: boolean } => {
    const groupFolders = chart.groupFolders ?? (new Map() as Folders)
    const stageFolders = chart.stageFolders ?? (new Map() as Folders)
    const usable = (parsed: readonly number[], given: readonly number[]) =>
        parsed.length === given.length && distinct(given)
    const mapping = (parsed: readonly number[], given: readonly number[], use: boolean) =>
        new Map(use ? parsed.map((id, i) => [id, given[i] ?? id]) : [])
    const parsed = {
        groups: ascending(chart.groups),
        stages: ascending(chart.stages),
        groupFolders: ascending(groupFolders),
        stageFolders: ascending(stageFolders),
    }
    const groupsKept = usable(parsed.groups, ids.groups)
    const stagesKept = usable(parsed.stages, ids.stages)
    const foldersKept =
        usable(parsed.groupFolders, ids.groupFolders) &&
        usable(parsed.stageFolders, ids.stageFolders) &&
        distinct([...ids.groupFolders, ...ids.stageFolders])
    const groupMap = mapping(parsed.groups, ids.groups, groupsKept)
    const stageMap = mapping(parsed.stages, ids.stages, stagesKept)
    const groupFolderMap = mapping(parsed.groupFolders, ids.groupFolders, foldersKept)
    const stageFolderMap = mapping(parsed.stageFolders, ids.stageFolders, foldersKept)
    const group = (id: GroupId) => (groupMap.get(id) ?? id) as GroupId
    const stage = (id: StageId) => (stageMap.get(id) ?? id) as StageId
    const folderIn = (map: Map<number, number>) => (id: FolderId | undefined) =>
        id === undefined ? {} : { folderId: (map.get(id) ?? id) as FolderId }
    const groupFolder = folderIn(groupFolderMap)
    const stageFolder = folderIn(stageFolderMap)
    const folders = (source: Folders, map: Map<number, number>): Folders =>
        new Map([...source].map(([id, folder]) => [(map.get(id) ?? id) as FolderId, folder]))

    const groups: Groups = new Map(
        [...chart.groups].map(([id, { folderId, ...rest }]) => [
            group(id),
            { ...rest, ...groupFolder(folderId) },
        ]),
    )
    const stages: Stages = new Map(
        [...chart.stages].map(([id, { folderId, ...rest }]) => [
            stage(id),
            { ...rest, ...stageFolder(folderId) },
        ]),
    )
    const withStage = <T extends { stageId: StageId }>(events: T[]) =>
        events.map((event) => ({ ...event, stageId: stage(event.stageId) }))
    const remapped: Chart = {
        ...chart,
        groups,
        stages,
        ...(chart.groupFolders
            ? { groupFolders: folders(chart.groupFolders, groupFolderMap) }
            : {}),
        ...(chart.stageFolders
            ? { stageFolders: folders(chart.stageFolders, stageFolderMap) }
            : {}),
        stageMaskEvents: withStage(chart.stageMaskEvents),
        stagePivotEvents: withStage(chart.stagePivotEvents),
        stageStyleEvents: withStage(chart.stageStyleEvents),
        stageTransformEvents: withStage(chart.stageTransformEvents),
        timeScales: chart.timeScales.map((scale) => ({ ...scale, groupId: group(scale.groupId) })),
        slides: chart.slides.map((slide) =>
            slide.map((note) => ({
                ...note,
                groupId: group(note.groupId),
                stageId: stage(note.stageId),
            })),
        ),
    }
    return { chart: remapped, all: groupsKept && stagesKept && foldersKept }
}

/** What replay makes of a journal's state. */
export type JournalState =
    | { kind: 'state'; state: State; idsKept: boolean }
    /** Level data with content this build doesn't read: left in place for a later build. */
    | { kind: 'later'; why: string }
    | { kind: 'unreadable'; why: string }

/**
 * The journal's state, built as replay builds it: the level data parsed with its report, the
 * ids given back, the header's level info and BGM records decoded.
 */
export const journalState = (journal: JournalV1): JournalState => {
    let levelData: LevelData
    try {
        levelData = journalLevelData(journal)
        checkShape(levelData)
    } catch (error) {
        return { kind: 'unreadable', why: `level data: ${String(error)}` }
    }
    const report = new LevelDataReport()
    let chart: Chart
    try {
        chart = parseLevelDataChart(
            levelData.entities,
            journal.editorMetadata?.defaultGuideColors ?? [],
            undefined,
            report,
        )
        // Replay never drops content a newer build wrote (§1.6.4 step 2).
        if (!report.isEmpty) return { kind: 'later', why: 'level data this build does not read' }
        validateChart(chart)
    } catch (error) {
        return { kind: 'unreadable', why: `level data: ${String(error)}` }
    }
    try {
        const levelInfo = levelInfoObject(journal.header.levelInfo as RecordValue[])
        const bgm = journal.header.bgm ? bgmObject(journal.header.bgm as RecordValue[]) : undefined
        const kept = withJournalIds(chart, journal.header.ids)
        const state = createState(kept.chart, levelData.bgmOffset, {
            levelInfo,
            ...(bgm ? { bgm } : {}),
        })
        return { kind: 'state', state, idsKept: kept.all }
    } catch (error) {
        return { kind: 'unreadable', why: `header: ${String(error)}` }
    }
}
