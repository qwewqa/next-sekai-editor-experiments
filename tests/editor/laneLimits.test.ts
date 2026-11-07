import assert from 'node:assert/strict'
import test from 'node:test'
import { migrateToolbar } from '../../src/editor/toolbar/migrate'
import {
    constrainLaneObject,
    edgeShiftRange,
    laneShiftRange,
    laneSpanOf,
    scaleFactorRange,
} from '../../src/state/operations/laneLimits'

test('unlimited and already-contained objects preserve identity and unrelated properties', () => {
    const note = { left: 4, size: 2, beat: 3, elevation: 5 }
    assert.equal(constrainLaneObject(note, 0), note)
    assert.equal(constrainLaneObject(note, 6), note)
    assert.deepEqual(constrainLaneObject({ ...note, left: 9 }, 6), { ...note, left: 4 })
    assert.deepEqual(constrainLaneObject({ ...note, left: -9 }, 6), { ...note, left: -6 })
})

test('resize limits preserve the fixed edge and respect fractional minimum widths', () => {
    assert.deepEqual(constrainLaneObject({ left: 2, size: 8 }, 6, true, 0.125), {
        left: 2,
        size: 4,
    })
    assert.deepEqual(constrainLaneObject({ left: -9, size: 11 }, 6, true, 0.125), {
        left: -6,
        size: 8,
    })
    assert.deepEqual(constrainLaneObject({ left: 9, size: 2 }, 6, true, 0.125), {
        left: 5.875,
        size: 0.125,
    })
    assert.deepEqual(constrainLaneObject({ left: 9, size: 0 }, 6), { left: 6, size: 0 })
})

test('oversized spans fit the range while cameras retain a valid minimum width', () => {
    assert.deepEqual(constrainLaneObject({ left: -8, size: 16 }, 6), { left: -6, size: 12 })
    assert.deepEqual(constrainLaneObject({ maskLeft: 3, maskSize: 20 }, 6), {
        maskLeft: -6,
        maskSize: 12,
    })
    assert.deepEqual(constrainLaneObject({ cameraLeft: 8, cameraSize: 12 }, 2), {
        cameraLeft: -3,
        cameraSize: 6,
    })
    assert.deepEqual(constrainLaneObject({ cameraLeft: 8, cameraSize: 12 }, 6), {
        cameraLeft: -6,
        cameraSize: 12,
    })
})

test('a move keeps a camera narrower than the editor makes, and a resize widens it', () => {
    assert.deepEqual(constrainLaneObject({ cameraLeft: 8, cameraSize: 2 }, 6), {
        cameraLeft: 4,
        cameraSize: 2,
    })
    assert.deepEqual(constrainLaneObject({ cameraLeft: 8, cameraSize: 0 }, 6), {
        cameraLeft: 6,
        cameraSize: 0,
    })
    assert.deepEqual(constrainLaneObject({ cameraLeft: 8, cameraSize: 2 }, 6, true), {
        cameraLeft: 0,
        cameraSize: 6,
    })
})

test('point events use their horizontal editing coordinate without changing other axes', () => {
    assert.deepEqual(constrainLaneObject({ pivotLane: -8, yOffset: 4 }, 2.5), {
        pivotLane: -2.5,
        yOffset: 4,
    })
    assert.deepEqual(constrainLaneObject({ xTranslation: 8, elevation: 4 }, 2.5), {
        xTranslation: 2.5,
        elevation: 4,
    })
    assert.deepEqual(constrainLaneObject({ editorLane: 8, beat: 4 }, 2.5), {
        editorLane: 2.5,
        beat: 4,
    })
    const bpm = { beat: 4, bpm: 120, meter: 4 }
    assert.equal(constrainLaneObject(bpm, 6), bpm)
})

test('fitted edges drop float noise, while kept and finer values stay exact', () => {
    // Inside the limits, a resize keeps the object: (0.1 + 0.2) - 0.1 is not 0.2.
    const note = { left: 0.1, size: 0.2 }
    assert.equal(constrainLaneObject(note, 6, true, 0.125), note)
    // 6.2 - 0.1 is 6.1000000000000005.
    assert.deepEqual(constrainLaneObject({ left: 9, size: 0.1 }, 6.2), { left: 6.1, size: 0.1 })
    // 6.1 - 0.2 is 5.8999999999999995, but 5.9 + 0.2 would pass 6.1.
    assert.deepEqual(constrainLaneObject({ left: 9, size: 0.2 }, 6.1), {
        left: 6.1 - 0.2,
        size: 0.2,
    })
    assert.deepEqual(constrainLaneObject({ left: 9, size: 0.123456789 }, 6.1), {
        left: 6.1 - 0.123456789,
        size: 0.123456789,
    })
})

test('a fitted edge snaps only while the object stays within the limit', () => {
    // 6 - 0.50000000001 snaps up to 5.5, which would leave the right edge past 6.
    const fitted = constrainLaneObject({ left: 9, size: 0.50000000001 }, 6)
    assert.deepEqual(fitted, { left: 6 - 0.50000000001, size: 0.50000000001 })
    assert.ok(fitted.left + fitted.size <= 6)
    // An object wider than the limits stays centred.
    assert.deepEqual(constrainLaneObject({ cameraLeft: 9, cameraSize: 6 }, 2), {
        cameraLeft: -3,
        cameraSize: 6,
    })
})

test('a resize cut at the limit keeps its fixed edge exact', () => {
    assert.deepEqual(constrainLaneObject({ left: 0.3, size: 8 }, 6, true), { left: 0.3, size: 5.7 })
    for (const left of [0.1 + 0.2, 2.00000000001]) {
        const fitted = constrainLaneObject({ left, size: 8 }, 6, true, 0.125)
        assert.equal(fitted.left, left)
        assert.ok(fitted.left + fitted.size <= 6)
        assert.ok(Math.abs(fitted.left + fitted.size - 6) < 1e-9)
    }
})

test('a resize past both limits moves an edge already past the left limit in', () => {
    assert.deepEqual(constrainLaneObject({ left: -8, size: 17 }, 6, true), { left: -6, size: 12 })
})

test('a group shifts as one until its first edge reaches the limit', () => {
    // Notes of different widths: the wider one's right edge stops the group.
    assert.deepEqual(
        laneShiftRange(
            [
                [-2, -1],
                [1, 4],
            ],
            6,
        ),
        [-4, 2],
    )
    // A slide's nodes at different lanes.
    assert.deepEqual(
        laneShiftRange(
            [
                [-1, 0],
                [2, 3],
                [4, 5],
            ],
            6,
        ),
        [-5, 1],
    )
    assert.equal(laneShiftRange([[0, 2]], 0), undefined)
    assert.equal(laneShiftRange([], 6), undefined)
})

test('a group past the limit shifts back in whole, and one wider than the range takes no edge further past it', () => {
    // From 0 to 7: any shift lands it within -6 to 6, at most one lane left of where it is.
    assert.deepEqual(
        laneShiftRange(
            [
                [0, 2],
                [5, 7],
            ],
            6,
        ),
        [-6, -1],
    )
    // From -8 to 8, past both sides: it stays.
    assert.deepEqual(
        laneShiftRange(
            [
                [-8, -7],
                [7, 8],
            ],
            6,
        ),
        [0, 0],
    )
    // From -4 to 10: it comes in until its left edge meets -6, and need not move at all,
    // so a move in time alone keeps its lanes.
    assert.deepEqual(
        laneShiftRange(
            [
                [-4, -2],
                [8, 10],
            ],
            6,
        ),
        [-2, 0],
    )
    // At the chart's bounds: the edge at -5000 stays, so no shift takes it past them.
    assert.deepEqual(
        laneShiftRange(
            [
                [-5000, -4998],
                [4999, 5002],
            ],
            5000,
        ),
        [0, 0],
    )
})

test('resized edges shift as one, none going further past the limit', () => {
    // Within the range: the first edge to reach a limit stops them.
    assert.deepEqual(edgeShiftRange([2, -5], 6), [-1, 4])
    // Past it: they stay, or come in gradually.
    assert.deepEqual(edgeShiftRange([18, 20], 6), [-24, 0])
    // Past it on both sides: they stay.
    assert.deepEqual(edgeShiftRange([-8, 8], 6), [0, 0])
    assert.equal(edgeShiftRange([2], 0), undefined)
    assert.equal(edgeShiftRange([], 6), undefined)
})

test('a span is the lane axis an object moves on', () => {
    assert.deepEqual(laneSpanOf({ left: 1, size: 2 }), [1, 3])
    assert.deepEqual(laneSpanOf({ cameraLeft: -3, cameraSize: 6 }), [-3, 3])
    assert.deepEqual(laneSpanOf({ maskLeft: 0, maskSize: 1 }), [0, 1])
    assert.deepEqual(laneSpanOf({ pivotLane: 2 }), [2, 2])
    assert.deepEqual(laneSpanOf({ xTranslation: -1 }), [-1, -1])
    assert.deepEqual(laneSpanOf({ editorLane: 4 }), [4, 4])
    assert.equal(laneSpanOf({ beat: 1, bpm: 120 }), undefined)
})

test('former default toolbar moves elevation to transforms and inserts lane limits after divisions', () => {
    const groups = [
        [
            'increaseNoteSize',
            'decreaseNoteSize',
            'brush',
            'eraser',
            'deselect',
            'elevation',
            'select',
        ],
        ['laneDivisionCustom', 'laneDivision1'],
        ['zoomXIn', 'zoomXOut', 'zoomYIn', 'zoomYOut'],
        ['scaleWidth', 'flip'],
    ]
    const migrated = migrateToolbar(groups)
    assert.equal(groups[0]?.includes('elevation'), true)
    assert.deepEqual(migrated[0], [
        'increaseNoteSize',
        'decreaseNoteSize',
        'brush',
        'eraser',
        'deselect',
        'select',
    ])
    assert.deepEqual(migrated[2], ['laneLimitCustom', 'laneLimitSix', 'laneLimitNone'])
    assert.deepEqual(migrated[4], ['elevation', 'scaleWidth', 'flip'])
    assert.equal(migrated[3]?.includes('elevation'), false)
    assert.equal(migrateToolbar(migrated), migrated)
    const custom = [['elevation', 'select']]
    assert.equal(migrateToolbar(custom), custom)
})

test('previous default view group moves elevation to transforms without duplicating lane controls', () => {
    const groups = [
        ['scaleWidth', 'scaleElevation', 'flip'],
        ['laneLimitCustom', 'laneLimitSix', 'laneLimitNone'],
        ['zoomXIn', 'zoomXOut', 'zoomYIn', 'zoomYOut', 'elevation'],
    ]
    const migrated = migrateToolbar(groups)
    assert.deepEqual(migrated[0], ['elevation', 'scaleWidth', 'scaleElevation', 'flip'])
    assert.deepEqual(migrated[2], ['zoomXIn', 'zoomXOut', 'zoomYIn', 'zoomYOut'])
    assert.equal(migrated.length, groups.length)
    assert.equal(migrateToolbar(migrated), migrated)
})

test('scaled edges keep within the limit, and one past it only comes back in', () => {
    // About 0: the edge at 5 reaches 6 at 1.2.
    assert.deepEqual(scaleFactorRange([0, 2, 3, 5], 0, 6), [0, 1.2])
    // The edge at 10 is past it: it can only come in.
    assert.deepEqual(scaleFactorRange([0, 2, 8, 10], 0, 6), [0, 1])
    // About an anchor past it at 7: shrinking stops when the edge at 5 meets 6, and growing when
    // the edge at 0 meets -6.
    assert.deepEqual(scaleFactorRange([0, 2, 5, 7], 7, 6), [0.5, 13 / 7])
})
