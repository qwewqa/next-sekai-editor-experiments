import type { Chart } from '../../src/chart'
import type { GroupId } from '../../src/chart/groups'
import type { NoteObject } from '../../src/chart/note'
import type { StageId } from '../../src/chart/stages'
import { createState } from '../../src/state'

export const note = (beat: number, overrides: Partial<NoteObject> = {}): NoteObject => ({
    groupId: 1 as GroupId,
    stageId: 1 as StageId,
    beat,
    noteType: 'default',
    isAttached: false,
    left: -1,
    size: 2,
    isCritical: false,
    flickDirection: 'none',
    isFake: false,
    noteStyle: 'default',
    connectorStyle: 'default',
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
    ...overrides,
})

export const chart = (
    slides: NoteObject[][],
    bpms: Chart['bpms'] = [{ beat: 0, bpm: 120 }],
): Chart => ({
    initialLife: 1000,
    isDynamicStages: false,
    bpms,
    groups: new Map([[1 as GroupId, { name: 'A' }]]),
    stages: new Map([
        [
            1 as StageId,
            { name: 'S', isFromStart: true, isUntilEnd: true, generateSimLines: 'global' },
        ],
    ]),
    cameraEvents: [],
    stageMaskEvents: [],
    stagePivotEvents: [],
    stageStyleEvents: [],
    stageTransformEvents: [],
    timeScales: [],
    slides,
})

// The hand-derived chart: BPM 120 from beat 0 and 60 from beat 8, each slide on its own.
export const handBuilt = (extra: NoteObject[][] = [], tail: Partial<NoteObject> = {}) => {
    const damage = { connectorType: 'damage' } as const
    const anchor = { noteType: 'anchor' } as const
    return createState(
        chart(
            [
                [note(0), note(2, tail)],
                [note(0.25, { noteType: 'trace' }), note(2, { flickDirection: 'up' })],
                [note(0, { isCritical: true }), note(1, { isConnectorSeparator: true }), note(2)],
                [note(0, { ...anchor, ...damage }), note(2, { ...anchor, ...damage })],
                [note(4), note(4)],
                [note(4, { ...anchor, ...damage }), note(4, { ...anchor, ...damage })],
                [note(0), note(1), note(2)],
                [note(0, { connectorIsFake: true }), note(2)],
                [note(0, { connectorType: 'guide' }), note(2, { connectorType: 'guide' })],
                [note(0, { noteType: 'forceNonTick' }), note(2 + 1 / 480)],
                [note(8), note(9, { noteType: 'forceNonTick' }), note(10)],
                [note(5, { noteType: 'forceTick' })],
                [note(6, { isCritical: true })],
                [note(6.5, { flickDirection: 'up' })],
                [note(7, { noteType: 'trace' })],
                [note(7.5, { noteType: 'damage' })],
                [note(12, { isFake: true })],
                [note(12.5, anchor)],
                ...extra,
            ],
            [
                { beat: 0, bpm: 120 },
                { beat: 8, bpm: 60 },
            ],
        ),
        0,
    )
}
