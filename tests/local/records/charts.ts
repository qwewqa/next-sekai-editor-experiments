import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import type { Chart } from '../../../src/chart'
import type { CameraEventObject } from '../../../src/chart/events/camera'
import type { StageMaskEventObject } from '../../../src/chart/events/stage/mask'
import type { StageStyleEventObject } from '../../../src/chart/events/stage/style'
import type { FolderId } from '../../../src/chart/folders'
import type { GroupId } from '../../../src/chart/groups'
import type { NoteObject } from '../../../src/chart/note'
import { parseLevelDataChart } from '../../../src/chart/parse/levelData'
import type { StageId } from '../../../src/chart/stages'
import { hash16Sync, toHex } from '../../../src/local/hash'
import { canonical } from '../../../src/local/records/canonical'
import type { SnapshotRecords } from '../../../src/local/records/records'
import { createState, type State, type StateExtras } from '../../../src/state'
import type { BgmMeta } from '../../../src/state/bgm'
import type { LevelInfo } from '../../../src/state/levelInfo'

// The record tests' charts: the samples, and the golden and edge charts that freeze with v1
// (§1.6.11.1). Changing the golden or edge chart changes frozen vectors: never after v0.6.0.

export const group = (id: number) => id as GroupId
export const stage = (id: number) => id as StageId
export const folder = (id: number) => id as FolderId

/** A note with every field set; group 1, stage 1, 2 lanes from lane 0. */
export const note = (beat: number, extra: Partial<NoteObject> = {}): NoteObject => ({
    groupId: group(1),
    stageId: stage(1),
    beat,
    elevation: 0,
    noteStyle: 'default',
    connectorStyle: 'default',
    noteType: 'default',
    isAttached: false,
    left: 0,
    size: 2,
    isCritical: false,
    flickDirection: 'none',
    isFake: false,
    sfx: 'default',
    isConnectorSeparator: false,
    connectorType: 'active',
    connectorEase: 'linear',
    connectorIsFake: false,
    connectorActiveIsCritical: false,
    connectorGuideAlpha: 1,
    connectorLayer: 'top',
    connectorIsPassThrough: false,
    connectorPresentation: 'default',
    ...extra,
})

export const camera = (
    beat: number,
    extra: Partial<CameraEventObject> = {},
): CameraEventObject => ({
    beat,
    cameraLeft: -6,
    cameraSize: 12,
    cameraZoom: 1,
    cameraZoomTargetLane: 0,
    cameraZoomTargetY: 0,
    cameraZoomVerticalAlign: 'default',
    cameraRotation: 0,
    cameraStageTilt: 0,
    eventEase: 'linear',
    ...extra,
})

export const mask = (
    beat: number,
    extra: Partial<StageMaskEventObject> = {},
): StageMaskEventObject => ({
    stageId: stage(1),
    beat,
    maskLeft: -6,
    maskSize: 12,
    isMaskNotes: false,
    eventEase: 'linear',
    ...extra,
})

export const style = (
    beat: number,
    extra: Partial<StageStyleEventObject> = {},
): StageStyleEventObject => ({
    stageId: stage(1),
    beat,
    editorLane: 0,
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
    ...extra,
})

/** A fake media hash, from a name. */
export const mediaHash = (name: string) => toHex(hash16Sync(new TextEncoder().encode(name)))

export type FixtureChart = { chart: Chart; offset: number; extras: StateExtras }

export const stateOf = ({ chart, offset, extras }: FixtureChart): State =>
    createState(structuredClone(chart), offset, extras)

/**
 * The golden chart (§1.6.11.1): two groups and a group folder, two stages, a slide with an
 * attached tick and an anchor, guides with a default and a set colour, elevation, notes and
 * a camera and a mask event at thirds and tenths of a lane, BPMs, a time-scale change, one
 * event of every kind, and level info with tags, cover, preview and BGM references.
 */
export const goldenChart = (): FixtureChart => ({
    offset: 0.125,
    extras: {
        levelInfo: {
            title: 'Golden',
            artists: 'Composer feat. Singer',
            author: 'Charter',
            description: 'Line one\nLine two',
            tags: [{ title: 'Tag' }, { title: 'Icon tag', icon: 'star' }],
            cover: {
                hash: mediaHash('cover'),
                filename: 'cover.png',
                size: 1234,
                type: 'image/png',
            },
            preview: {
                hash: mediaHash('preview'),
                filename: 'preview.mp3',
                size: 56789,
                type: 'audio/mpeg',
            },
            rating: 12,
        },
        bgm: {
            hash: mediaHash('bgm'),
            filename: 'song.mp3',
            size: 4000000,
            type: 'audio/mpeg',
            durationMs: 123456,
        },
    },
    chart: {
        initialLife: 1000,
        isDynamicStages: true,
        bpms: [
            { beat: 0, bpm: 120, meter: 4 },
            { beat: 8, bpm: 150, meter: 3 },
        ],
        groups: new Map([
            [group(1), { name: 'Default', folderId: folder(1) }],
            [group(2), { name: 'Fast', forceNoteSpeed: 10.5, folderId: folder(1) }],
        ]),
        stages: new Map([
            [
                stage(1),
                { name: 'Main', isFromStart: true, isUntilEnd: true, generateSimLines: 'global' },
            ],
            [
                stage(2),
                {
                    name: 'Side',
                    isFromStart: false,
                    isUntilEnd: true,
                    generateSimLines: 'isolated',
                },
            ],
        ]),
        groupFolders: new Map([[folder(1), { name: 'Folder', index: 0 }]]),
        stageFolders: new Map(),
        cameraEvents: [camera(0), camera(2, { cameraLeft: 1 / 3, cameraSize: 2 / 3 })],
        stageMaskEvents: [mask(0), mask(2, { maskLeft: 0.7, maskSize: 0.3, isMaskNotes: true })],
        stagePivotEvents: [
            {
                stageId: stage(1),
                beat: 1,
                pivotLane: 0,
                divisionSize: 2,
                divisionParity: 'odd',
                yOffset: 0.5,
                yOffsetBeat: 1,
                eventEase: 'outQuad',
            },
        ],
        stageStyleEvents: [style(1, { judgmentLineColor: 'cyan', leftBorderStyle: 'light' })],
        stageTransformEvents: [
            {
                stageId: stage(2),
                beat: 3,
                rotation: 15,
                xTranslation: 1,
                yTranslation: -1,
                elevation: 0.25,
                anchor: 'center',
                eventEase: 'inOutSine',
            },
        ],
        timeScales: [
            {
                groupId: group(1),
                beat: 4,
                editorLane: 0,
                timeScale: 1.5,
                skip: 0,
                timeScaleEase: 'linear',
                timeScaleTransition: 'timeScale',
                hideNotes: false,
            },
        ],
        slides: [
            [
                note(0, { left: 1 / 3, elevation: 0.5 }),
                note(1, { left: 1 / 3, isAttached: true }),
                note(1.5, { left: 1 / 3, noteType: 'anchor' }),
                note(2, { left: 1 / 3, flickDirection: 'up' }),
            ],
            [
                note(3, { left: 0.7, size: 0.3, connectorType: 'guide', groupId: group(2) }),
                note(4, { left: 0.7, size: 0.3, connectorType: 'guide', groupId: group(2) }),
            ],
            [
                note(5, { connectorType: 'guide', connectorStyle: 'blue' }),
                note(6, { connectorType: 'guide', connectorStyle: 'blue' }),
            ],
            [note(5, { isCritical: true, noteStyle: 'red', stageId: stage(2), groupId: group(2) })],
        ],
    },
})

const astral = '\u{1F600}'
const loneHigh = '\uD83D'

/**
 * The edge chart (§1.6.11.1): number spellings, text escapes, ties, same-beat events in chain
 * order against byte order, window boundaries, the three splits and a depth-1 node.
 */
export const edgeChart = (): FixtureChart => {
    const slides: NoteObject[][] = []
    // Window 2 (beats 32–48): 30 slides over its 4-beat parts.
    for (let i = 0; i < 30; i++) slides.push([note(32 + (i % 2) * 4 + i * 0.125, { left: i % 12 })])
    // Window 3 (48–64): one 4-beat part of 30 slides over its 1-beat parts.
    for (let i = 0; i < 30; i++) slides.push([note(48 + (i % 2) + i * 0.03125, { left: i % 12 })])
    // Window 4 (64–80): one 1-beat part of 30 slides, in runs of 24.
    for (let i = 0; i < 30; i++) slides.push([note(64 + i / 64, { left: i % 12 })])
    // Windows 5–24, one slide each, so slides have more than 16 chunks.
    for (let w = 5; w < 25; w++) slides.push([note(w * 16 + 1)])
    // A window boundary.
    slides.push([note(16)], [note(15.999999999999998)])
    // A slide over three windows.
    slides.push([note(10), note(20, { isAttached: true }), note(40)])
    // Lane divisions 3, 5, 6, 10 and 12, elevation 0 beside 0.5.
    for (const [i, n] of [3, 5, 6, 10, 12].entries())
        slides.push([note(2 + i, { left: 1 / n, size: 7 / n, elevation: i % 2 ? 0.5 : 0 })])
    return {
        offset: -0,
        extras: {
            levelInfo: {
                title: 'Caf\u00e9 / Cafe\u0301',
                artists: `${astral}${loneHigh} 日本語`,
                author: 'quote " backslash \\ slash /',
                description: 'tab\tline\u2028para\u2029nul\u0000vt\u000bdel\u007f',
                tags: [{ title: '\u00e9' }, { title: 'e\u0301', icon: '' }],
                rating: 0,
            },
            bgm: { hash: mediaHash('edge-bgm'), filename: '', size: 0, type: '' },
        },
        chart: {
            initialLife: 2 ** 53 - 1,
            isDynamicStages: true,
            bpms: [
                { beat: 0, bpm: 0.30000000000000004, meter: 4 },
                { beat: 16, bpm: 1e21, meter: 4 },
                { beat: 15.999999999999998, bpm: 1e20, meter: 4 },
            ],
            groups: new Map([
                [group(3), { name: 'Caf\u00e9', forceNoteSpeed: 1e-7 }],
                [group(7), { name: 'Cafe\u0301' }],
            ]),
            stages: new Map([
                [
                    stage(1),
                    {
                        name: `ctl\u0001\u001f"\\/`,
                        isFromStart: true,
                        isUntilEnd: true,
                        generateSimLines: 'global',
                    },
                ],
                [
                    stage(4),
                    {
                        name: '\u2028\u2029',
                        isFromStart: true,
                        isUntilEnd: false,
                        generateSimLines: 'global',
                    },
                ],
            ]),
            groupFolders: new Map(),
            stageFolders: new Map(),
            cameraEvents: [
                camera(0, { cameraZoom: 1e-6, cameraRotation: -1e-7 }),
                camera(1, { cameraZoom: 1e20, cameraRotation: -1.5, cameraStageTilt: -0 }),
                camera(2, { cameraLeft: 0.1, cameraSize: 1 / 3 }),
            ],
            // On stage 1 at beat 129, chain order is the reverse of byte order, as in coconut.
            stageMaskEvents: [
                mask(129, { maskLeft: -6, maskSize: 12 }),
                mask(129, { maskLeft: -2, maskSize: 4 }),
                mask(130, { stageId: stage(4) }),
            ],
            stagePivotEvents: [],
            // Two identical events: a tie by bytes.
            stageStyleEvents: [style(8), style(8), style(9, { noteAlpha: 5e-324 })],
            stageTransformEvents: [
                {
                    stageId: stage(4),
                    beat: 0,
                    rotation: 1.7976931348623157e308,
                    xTranslation: -0,
                    yTranslation: 2 ** 53,
                    elevation: 0.5,
                    anchor: 'default',
                    eventEase: 'none',
                },
            ],
            timeScales: [
                {
                    groupId: group(7),
                    beat: 3,
                    editorLane: 3.5,
                    timeScale: 2,
                    skip: 0,
                    timeScaleEase: 'none',
                    timeScaleTransition: 'scroll',
                    hideNotes: true,
                },
                {
                    groupId: group(3),
                    beat: 3,
                    editorLane: -1,
                    timeScale: 0.5,
                    skip: 1,
                    timeScaleEase: 'linear',
                    timeScaleTransition: 'timeScale',
                    hideNotes: false,
                },
            ],
            slides: slides.map((slide) =>
                slide.map((n) => ({ ...n, groupId: group(n.beat < 64 ? 3 : 7) })),
            ),
        },
    }
}

/** Extra header variants the edge set pins beside its chart: level info and BGM forms. */
export const edgeHeaderVariants = (): { name: string; levelInfo: LevelInfo; bgm?: BgmMeta }[] => [
    {
        name: 'rating-unset',
        levelInfo: { title: 'No rating', artists: '', author: '', description: '', tags: [] },
    },
    {
        name: 'level-info-empty',
        levelInfo: { title: '', artists: '', author: '', description: '', tags: [] },
    },
    {
        name: 'bgm-with-duration',
        levelInfo: { title: '', artists: '', author: '', description: '', tags: [] },
        bgm: {
            hash: mediaHash('edge-bgm'),
            filename: 'song.ogg',
            size: 1,
            type: 'audio/ogg',
            durationMs: 0,
        },
    },
]

/** Level data from a file: plain, gzipped, or a legacy auto save holding it. */
export const readLevelData = (path: string): { bgmOffset: number; entities: never[] } => {
    const bytes = readFileSync(path)
    const text = bytes[0] === 0x1f ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8')
    const data = JSON.parse(text) as Record<string, unknown>
    const autoSave = data.autoSave as { levelData?: string } | undefined
    if (typeof autoSave?.levelData === 'string')
        return JSON.parse(gunzipSync(Buffer.from(autoSave.levelData, 'base64')).toString('utf8'))
    return data as never
}

/** The sample levels every round trip runs over. */
export const samplePaths = [
    'test_level_data/coconut-next-sekai-24887.json',
    'tests/fixtures/generated-large.json',
    'tests/browser/fixtures/legacy-colors.json',
]

export const sampleState = (path: string): State => {
    const { bgmOffset, entities } = readLevelData(path)
    return createState(parseLevelDataChart(entities), bgmOffset)
}

/** Records as one canonical text, so a difference shows where it is. */
export const recordsText = ({ header, kinds }: SnapshotRecords) =>
    canonical([
        header,
        kinds.map(({ kind, records }) => [kind, records.map(({ record }) => record)]),
    ])
