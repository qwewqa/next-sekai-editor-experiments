import type { LevelDataEntity } from '@sonolus/core'

type Data = Record<string, number | { ref: string }>

export const entity = (archetype: string, data: Data, name?: string): LevelDataEntity => ({
    ...(name === undefined ? {} : { name }),
    archetype,
    data: Object.entries(data).map(([key, value]) =>
        typeof value === 'number' ? { name: key, value } : { name: key, ref: value.ref },
    ),
})

export const ref = (name: string) => ({ ref: name })

/** The fields of a note, each one the parser reads. */
export const noteData = (extra: Data = {}): Data => ({
    '#TIMESCALE_GROUP': ref('g0'),
    '#BEAT': 1,
    lane: 0,
    size: 1,
    elevation: 0.5,
    style: 2,
    direction: 0,
    isAttached: 0,
    isSeparator: 0,
    connectorEase: 1,
    segmentKind: 1,
    segmentAlpha: 1,
    segmentLayer: 1,
    effectKind: 2,
    segmentThroughJudgeLine: 0,
    segmentPresentation: 1,
    ...extra,
})

/** A level with the smallest parts the parser needs: no stages, one note. */
export const minimalLevel = (): LevelDataEntity[] => [
    entity('Initialization', { initialLife: 1000, revision: 2 }),
    entity('#BPM_CHANGE', { '#BEAT': 0, '#BPM': 120 }),
    entity('#TIMESCALE_GROUP', {}, 'g0'),
    entity('NormalTapNote', {
        '#TIMESCALE_GROUP': ref('g0'),
        '#BEAT': 1,
        lane: 0,
        size: 1,
        direction: 0,
        isAttached: 0,
        connectorEase: 1,
        segmentKind: 1,
        segmentAlpha: 1,
    }),
]

/** A folder nested in the full level's first folder, which the parser flattens and reports. */
export const nestedFolder = (): LevelDataEntity =>
    entity(
        'EditorGroupFolder',
        { editorName: ref('Inner'), editorIndex: 1, editorFolder: ref('gf0') },
        'gf1',
    )

/**
 * A level with dynamic stages that uses every archetype and field the table declares, and the
 * archetypes and fields it reads past on purpose.
 */
export const fullLevel = (): LevelDataEntity[] => [
    entity('Initialization', { initialLife: 800, revision: 2, firstCamera: ref('cam0') }),
    entity('#BPM_CHANGE', { '#BEAT': 0, '#BPM': 120, meter: 3 }),
    entity('EditorGroupFolder', { editorName: ref('Folder'), editorIndex: 0 }, 'gf0'),
    entity(
        '#TIMESCALE_GROUP',
        {
            editorName: ref('Group'),
            editorFolder: ref('gf0'),
            forceNoteSpeed: 3.5,
            first: ref('tc0'),
            editorHidden: 0,
        },
        'g0',
    ),
    entity(
        '#TIMESCALE_CHANGE',
        {
            '#TIMESCALE_GROUP': ref('g0'),
            '#BEAT': 0,
            editorLane: -5,
            '#TIMESCALE': 1,
            '#TIMESCALE_SKIP': 0,
            '#TIMESCALE_EASE': 3,
            transitionStyle: 1,
            hideNotes: 1,
            next: ref('tc1'),
        },
        'tc0',
    ),
    entity(
        '#TIMESCALE_CHANGE',
        {
            '#TIMESCALE_GROUP': ref('g0'),
            '#BEAT': 4,
            '#TIMESCALE': 2,
            '#TIMESCALE_SKIP': 0,
            '#TIMESCALE_EASE': 0,
        },
        'tc1',
    ),
    entity('EditorStageFolder', { editorName: ref('Stages'), editorIndex: 0 }, 'sf0'),
    entity(
        'Stage',
        {
            editorName: ref('Stage'),
            editorFolder: ref('sf0'),
            fromStart: 1,
            untilEnd: 1,
            generateSimLines: 1,
            firstMaskChange: ref('m0'),
            firstPivotChange: ref('p0'),
            firstStyleChange: ref('y0'),
            firstTransformChange: ref('x0'),
        },
        's0',
    ),
    entity(
        'CameraChange',
        {
            '#BEAT': 0,
            lane: 0,
            size: 6,
            zoom: 1.5,
            zoomTargetLane: 1,
            zoomTargetY: 0.5,
            zoomVerticalAlign: 1,
            rotate: 10,
            stageTilt: 0.5,
            ease: 2,
            next: ref('cam1'),
        },
        'cam0',
    ),
    entity('CameraChange', { '#BEAT': 4, lane: 1, size: 7, ease: 1 }, 'cam1'),
    entity(
        'StageMaskChange',
        { '#BEAT': 0, lane: 0, size: 4, maskNotes: 1, ease: 3, next: ref('m1'), stage: ref('s0') },
        'm0',
    ),
    entity('StageMaskChange', { '#BEAT': 4, lane: 1, size: 5, ease: 1, stage: ref('s0') }, 'm1'),
    entity(
        'StagePivotChange',
        {
            '#BEAT': 0,
            lane: 0,
            divisionSize: 2,
            divisionParity: 1,
            yOffset: 0.5,
            yBeatOffset: 1,
            ease: 4,
            stage: ref('s0'),
        },
        'p0',
    ),
    entity(
        'StageStyleChange',
        {
            '#BEAT': 0,
            editorLane: 2,
            judgeLineColor: 3,
            judgeLineStyle: 1,
            leftBorderStyle: 1,
            rightBorderStyle: 2,
            fullWidth: 1,
            noteAlpha: 0.5,
            laneAlpha: 0.5,
            judgeLineAlpha: 0.5,
            divisionLineAlpha: 0.5,
            alpha: 0.5,
            ease: 5,
            next: ref('y1'),
            stage: ref('s0'),
        },
        'y0',
    ),
    entity(
        'StageStyleChange',
        {
            '#BEAT': 4,
            judgeLineColor: 0,
            leftBorderStyle: 0,
            rightBorderStyle: 0,
            laneAlpha: 1,
            judgeLineAlpha: 1,
            ease: 1,
            stage: ref('s0'),
        },
        'y1',
    ),
    entity(
        'StageTransformChange',
        {
            '#BEAT': 0,
            rotate: 5,
            xLaneTranslate: 1,
            yLaneTranslate: 1,
            elevation: 0.5,
            anchor: 1,
            ease: 6,
            stage: ref('s0'),
        },
        'x0',
    ),
    entity(
        'NormalHeadFlickNote',
        noteData({ stage: ref('s0'), direction: 1, next: ref('n1'), attachHead: ref('n0') }),
        'n0',
    ),
    entity(
        'NormalTailReleaseNote',
        noteData({ stage: ref('s0'), '#BEAT': 2, attachTail: ref('n1'), activeHead: ref('n0') }),
        'n1',
    ),
    entity('FakeCriticalTickNote', noteData({ stage: ref('s0'), '#BEAT': 3 }), 'n2'),
    entity('Connector', { head: ref('n0'), tail: ref('n1') }),
    entity('SimLine', { left: ref('n0'), right: ref('n1') }),
    entity('TransientHiddenTickNote', { '#BEAT': 1.5, isAttached: 1 }),
    entity('TransientHiddenDamageTickNote', { '#BEAT': 1.5, isAttached: 1 }),
]
