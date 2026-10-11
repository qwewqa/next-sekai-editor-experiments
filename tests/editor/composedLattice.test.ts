import assert from 'node:assert/strict'
import test from 'node:test'
import type { Chart } from '../../src/chart'
import type { StagePivotEventObject } from '../../src/chart/events/stage/pivot'
import type { GroupId } from '../../src/chart/groups'
import type { StageId } from '../../src/chart/stages'
import { createComposedLayout } from '../../src/editor/composed'
import { isLatticeMoved } from '../../src/editor/snapping'
import { createState } from '../../src/state'

const groupId = 1 as GroupId
const stageId = 1 as StageId
const pivot = (
    beat: number,
    pivotLane: number,
    extra: Partial<StagePivotEventObject> = {},
): StagePivotEventObject => ({
    stageId,
    beat,
    pivotLane,
    divisionSize: 2,
    divisionParity: 'even',
    yOffset: 0,
    yOffsetBeat: 0,
    eventEase: 'linear',
    ...extra,
})
const layoutOf = (overrides: Partial<Chart>) =>
    createComposedLayout(
        createState(
            {
                initialLife: 1000,
                isDynamicStages: true,
                bpms: [{ beat: 0, bpm: 60 }],
                groups: new Map([[groupId, { name: 'Default' }]]),
                stages: new Map([
                    [
                        stageId,
                        {
                            name: '1',
                            isFromStart: true,
                            isUntilEnd: true,
                            generateSimLines: 'global' as const,
                        },
                    ],
                ]),
                cameraEvents: [],
                stageMaskEvents: [],
                stagePivotEvents: [],
                stageStyleEvents: [],
                stageTransformEvents: [],
                timeScales: [],
                slides: [],
                ...overrides,
            },
            0,
        ),
    )
// Whether the stage's lattice at to differs from the one at from, as Select and the tools judge it.
const moved = (layout: ReturnType<typeof layoutOf>, from: number, to: number, division = 1) =>
    isLatticeMoved(
        { offset: layout.offset(stageId, from), grid: layout.gridOffset(stageId, from) },
        { offset: layout.offset(stageId, to), grid: layout.gridOffset(stageId, to) },
        division,
    )

test('half a lane of translation with a parity flip moves the lattice, though the drawn lines stay', () => {
    const layout = layoutOf({
        stagePivotEvents: [
            pivot(0, 0, { divisionSize: 11 }),
            pivot(8, 0.5, { divisionSize: 11, divisionParity: 'odd' }),
        ],
    })
    assert.equal(layout.offset(stageId, 12) - layout.offset(stageId, 0), 0.5)
    assert.equal(layout.gridOffset(stageId, 12) - layout.gridOffset(stageId, 0), 0.5)
    assert.equal(moved(layout, 0, 12), true)
    assert.equal(moved(layout, 0, 12, 2), false)
})

test('a stage moving by part of a lane moves its lattice; whole lanes and float noise do not', () => {
    const quarter = layoutOf({ stagePivotEvents: [pivot(0, 0.2), pivot(8, 2.2)] })
    assert.equal(moved(quarter, 4, 6), true)
    assert.equal(moved(quarter, 4, 6, 2), false)
    assert.equal(moved(quarter, 4, 4), false)
    const half = layoutOf({ stagePivotEvents: [pivot(0, 0.2), pivot(8, 4.2)] })
    assert.equal(moved(half, 4, 6), false)
    // Not bit-exact: 0.5000000000000001 lanes.
    const noisy = layoutOf({ stagePivotEvents: [pivot(0, 0.1), pivot(8, 2.1)] })
    const shift = noisy.offset(stageId, 4) - noisy.offset(stageId, 2)
    assert.notEqual(shift, 0.5)
    assert.equal(moved(noisy, 2, 4, 2), false)
    // Past the last event the stage holds its last place.
    assert.equal(moved(quarter, 8, 20), false)
    assert.equal(moved(quarter, 6, 20), true)
})

test('a stepped stage is judged on the side a note there is drawn on', () => {
    const layout = layoutOf({
        stagePivotEvents: [pivot(0, 0, { eventEase: 'none' }), pivot(2.3, 0.3)],
    })
    assert.equal(moved(layout, 0.1, 2.3), false)
    assert.equal(moved(layout, 0.1, 2.3 + 1e-9), true)
})

test('a tempo change inside one stretch moves the lattice of a note moved with all its stage events', () => {
    const stagePivotEvents = [pivot(0, 0.2), pivot(8, 2.2)]
    const shifted = [pivot(2, 0.2), pivot(10, 2.2)]
    const press = layoutOf({ stagePivotEvents })
    const lattice = (layout: ReturnType<typeof layoutOf>, beat: number) => ({
        offset: layout.offset(stageId, beat),
        grid: layout.gridOffset(stageId, beat),
    })
    // At one tempo the note keeps its place between its events.
    assert.equal(
        isLatticeMoved(lattice(press, 4), lattice(layoutOf({ stagePivotEvents: shifted }), 6), 1),
        false,
    )
    const bpms = [
        { beat: 0, bpm: 60 },
        { beat: 1, bpm: 120 },
    ]
    assert.equal(
        isLatticeMoved(
            lattice(layoutOf({ bpms, stagePivotEvents }), 4),
            lattice(layoutOf({ bpms, stagePivotEvents: shifted }), 6),
            1,
        ),
        true,
    )
})
