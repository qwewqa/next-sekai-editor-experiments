import type { Chart } from '../../src/chart'
import type { GroupId } from '../../src/chart/groups'
import type { NoteObject } from '../../src/chart/note'
import type { StageId } from '../../src/chart/stages'
import { createState } from '../../src/state'

export const groupId = 1 as GroupId
export const stageA = 1 as StageId
export const stageB = 2 as StageId

/** A default note on stage A, 2 lanes wide. */
export const note = (beat: number, left = 0, extra: Partial<NoteObject> = {}): NoteObject => ({
    groupId,
    stageId: stageA,
    beat,
    noteType: 'default',
    isAttached: false,
    left,
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
    ...extra,
})

/** A chart of these slides on stages A and B at 60 BPM, without events. */
export const chartState = (slides: NoteObject[][], overrides: Partial<Chart> = {}) =>
    createState(
        {
            initialLife: 1000,
            isDynamicStages: false,
            bpms: [{ beat: 0, bpm: 60 }],
            groups: new Map([[groupId, { name: 'Default' }]]),
            stages: new Map([
                [
                    stageA,
                    { name: 'A', isFromStart: true, isUntilEnd: true, generateSimLines: 'global' },
                ],
                [
                    stageB,
                    { name: 'B', isFromStart: true, isUntilEnd: true, generateSimLines: 'global' },
                ],
            ]),
            cameraEvents: [],
            stageMaskEvents: [],
            stagePivotEvents: [],
            stageStyleEvents: [],
            stageTransformEvents: [],
            timeScales: [],
            slides,
            ...overrides,
        },
        0,
    )
