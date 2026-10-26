import type { LevelDataEntity } from '@sonolus/core'
import Type from 'typebox'
import type { Chart } from '../..'
import { knownChoiceOf } from '../../../levelData/known'
import { LevelDataReport, reportLevelDataEntities } from '../../../levelData/report'
import {
    groupFolderArchetype,
    normalizeFolders,
    stageFolderArchetype,
    type FolderId,
    type Folders,
} from '../../folders'
import { addToGroups, type GroupId, type GroupObject } from '../../groups'
import type { NoteObject } from '../../note'
import { ImportRefusal } from '../../refusal'
import { addDefaultStageToStages, addToStages, type StageId, type StageObject } from '../../stages'
import { parseBpmsToChart } from './bpm'
import { check } from './check'
import { parseCameraEventsToChart } from './events/camera'
import { parseStageMaskEventsToChart } from './events/stage/mask'
import { parseStagePivotEventsToChart } from './events/stage/pivot'
import { parseStageStyleEventsToChart } from './events/stage/style'
import { parseStageTransformEventsToChart } from './events/stage/transform'
import { parseFoldersToChart } from './folder'
import { parseGroupsToChart } from './group'
import { parseInitializationToChart } from './initialization'
import { parseSlidesToChart } from './slide'
import { parseStagesToChart } from './stage'
import { parseTimeScalesToChart } from './timeScale'

export type ParseCtx = {
    chart: Chart
    entities: LevelDataEntity[]
    defaultGuideColors: ReadonlySet<LevelDataEntity>
    noteSources?: Map<NoteObject, LevelDataEntity>

    /** The folder an entity's `editorFolder` ref names, if it exists. */
    getGroupFolderId: (entity: LevelDataEntity) => FolderId | undefined
    getStageFolderId: (entity: LevelDataEntity) => FolderId | undefined

    getGroupId: (entity: LevelDataEntity) => GroupId
    addGroup: (
        name: string | undefined,
        editorName: string | undefined,
        object: Omit<GroupObject, 'name'>,
    ) => void

    getStageId: (entity: LevelDataEntity) => StageId
    addStage: (
        name: string | undefined,
        editorName: string | undefined,
        object: Omit<StageObject, 'name'>,
    ) => StageId
}

/**
 * Parses level data into a chart. With a `report`, what the parser does not read is added to it
 * and an unknown choice value becomes its field's default; without one, an unknown choice
 * value refuses the level as before.
 */
export const parseLevelDataChart = (
    entities: LevelDataEntity[],
    defaultGuideColors: readonly number[] = [],
    noteSources?: Map<NoteObject, LevelDataEntity>,
    report?: LevelDataReport,
): Chart => {
    if (report) reportLevelDataEntities(entities, report)
    activeReport = report
    reportedValues = new WeakMap()
    try {
        return parseEntities(entities, defaultGuideColors, noteSources)
    } finally {
        activeReport = undefined
        reportedValues = new WeakMap()
    }
}

// The parse is synchronous and does not nest, so the helpers can reach its report here.
let activeReport: LevelDataReport | undefined
// The fields whose unknown value an entity has already added, since a field can be read twice.
let reportedValues = new WeakMap<LevelDataEntity, Set<string>>()

const parseEntities = (
    entities: LevelDataEntity[],
    defaultGuideColors: readonly number[],
    noteSources: Map<NoteObject, LevelDataEntity> | undefined,
): Chart => {
    const chart: Chart = {
        initialLife: 1000,
        isDynamicStages: false,
        bpms: [],
        groups: new Map(),
        stages: new Map(),
        cameraEvents: [],
        stageMaskEvents: [],
        stagePivotEvents: [],
        stageStyleEvents: [],
        stageTransformEvents: [],
        timeScales: [],
        slides: [],
    }

    const groupFolders: Folders = new Map()
    const stageFolders: Folders = new Map()
    const groupFolderIds = parseFoldersToChart(
        { entities },
        groupFolderArchetype,
        groupFolders,
        stageFolders,
    )
    const stageFolderIds = parseFoldersToChart(
        { entities },
        stageFolderArchetype,
        stageFolders,
        groupFolders,
    )
    const folderIdOf = (ids: Map<string, FolderId>, entity: LevelDataEntity) => {
        const ref = getOptionalRef(entity, 'editorFolder')
        return ref === undefined ? undefined : ids.get(ref)
    }

    const groupIds = new Map<string, GroupId>()
    const stageIds = new Map<string, StageId>()
    let defaultStageId: StageId

    const ctx: ParseCtx = {
        chart,
        entities,
        defaultGuideColors: new Set(defaultGuideColors.flatMap((index) => entities[index] ?? [])),
        noteSources,

        getGroupFolderId: (entity) => folderIdOf(groupFolderIds, entity),
        getStageFolderId: (entity) => folderIdOf(stageFolderIds, entity),

        getGroupId(entity) {
            const ref = getRef(entity, '#TIMESCALE_GROUP')
            const id = groupIds.get(ref)
            if (!id) throw new ImportRefusal('refNotFound', ref)

            return id
        },
        addGroup(name, editorName, object) {
            const [id] = addToGroups(chart.groups, editorName, object)

            if (name) {
                groupIds.set(name, id)
            }
        },

        getStageId(entity) {
            const ref = getOptionalRef(entity, 'stage')
            if (chart.isDynamicStages) {
                if (ref === undefined) throw new ImportRefusal('dataNotFound', 'stage')

                const id = stageIds.get(ref)
                if (!id) throw new ImportRefusal('refNotFound', ref)

                return id
            } else {
                if (ref !== undefined) throw new ImportRefusal('refNotFound', ref)

                return defaultStageId
            }
        },
        addStage(name, editorName, object) {
            chart.isDynamicStages = true
            const [id] = addToStages(chart.stages, editorName, object)

            if (name) {
                stageIds.set(name, id)
            }

            return id
        },
    }

    const firstCameraRef = parseInitializationToChart(ctx)

    parseBpmsToChart(ctx)

    parseGroupsToChart(ctx)
    if (!chart.groups.size) {
        addToGroups(chart.groups)
    }

    const { firstMaskRefs, firstPivotRefs, firstStyleRefs, firstTransformRefs } =
        parseStagesToChart(ctx)
    if (!chart.stages.size) {
        ;[defaultStageId] = addDefaultStageToStages(chart.stages)
    }

    // Folders gather their members wherever the file listed them.
    ;({ entries: chart.groups, folders: chart.groupFolders } = normalizeFolders(
        chart.groups,
        groupFolders,
    ))
    // Stage folders exist only with dynamic stages.
    if (chart.isDynamicStages)
        ({ entries: chart.stages, folders: chart.stageFolders } = normalizeFolders(
            chart.stages,
            stageFolders,
        ))

    parseCameraEventsToChart(ctx, firstCameraRef)

    parseStageMaskEventsToChart(ctx, firstMaskRefs)
    parseStagePivotEventsToChart(ctx, firstPivotRefs)
    parseStageStyleEventsToChart(ctx, firstStyleRefs)
    parseStageTransformEventsToChart(ctx, firstTransformRefs)

    parseTimeScalesToChart(ctx)

    parseSlidesToChart(ctx)

    return chart
}

/** One read through a helper, for the test that the declared table and the parser agree. */
export type ParserRead = {
    archetype: string
    name: string
    kind: 'value' | 'ref'
    required: boolean
    schema?: Type.TSchema
}

let onRead: ((read: ParserRead) => void) | undefined

export const setParserReadHook = (hook: typeof onRead) => {
    onRead = hook
}

// A choice the editor doesn't know is unknown; other refused values are invalid.
const checked = <T extends Type.TSchema>(
    entity: LevelDataEntity,
    name: string,
    schema: T,
    value: unknown,
) => {
    if (check(schema, value)) return value as Type.Static<T>

    // The declared table says which fields are choices, and gives their defaults.
    const choice = knownChoiceOf(entity.archetype, name)
    const isChoice =
        choice !== undefined ||
        (Type.IsUnion(schema) && schema.anyOf.every((option) => Type.IsLiteral(option)))
    if (!isChoice) throw new ImportRefusal('invalidValue', name)

    // The report records the value and the field's default stands in.
    if (!activeReport || !choice) throw new ImportRefusal('unknownValue', name)

    const reported = reportedValues.get(entity) ?? new Set<string>()
    reportedValues.set(entity, reported)
    if (!reported.has(name)) activeReport.addValue(entity.archetype, name, value)
    reported.add(name)
    return choice.default as Type.Static<T>
}

export const getValue = <T extends Type.TSchema>(
    entity: LevelDataEntity,
    name: string,
    schema: T,
) => {
    onRead?.({ archetype: entity.archetype, name, kind: 'value', required: true, schema })
    const data = entity.data.find((data) => data.name === name)
    if (!data) throw new ImportRefusal('dataNotFound', name)
    if (!('value' in data)) throw new ImportRefusal('dataNoValue', name)

    return checked(entity, name, schema, data.value)
}

export const getOptionalValue = <T extends Type.TSchema>(
    entity: LevelDataEntity,
    name: string,
    schema: T,
) => {
    onRead?.({ archetype: entity.archetype, name, kind: 'value', required: false, schema })
    const data = entity.data.find((data) => data.name === name)
    if (!data) return
    if (!('value' in data)) return

    return checked(entity, name, schema, data.value)
}

export const getRef = (entity: LevelDataEntity, name: string) => {
    onRead?.({ archetype: entity.archetype, name, kind: 'ref', required: true })
    const data = entity.data.find((data) => data.name === name)
    if (!data) throw new ImportRefusal('dataNotFound', name)
    if (!('ref' in data)) throw new ImportRefusal('dataNoRef', name)

    return data.ref
}

export const getOptionalRef = (entity: LevelDataEntity, name: string) => {
    onRead?.({ archetype: entity.archetype, name, kind: 'ref', required: false })
    const data = entity.data.find((data) => data.name === name)
    if (!data) return
    if (!('ref' in data)) return

    return data.ref
}
