import assert from 'node:assert/strict'
import test from 'node:test'
import {
    elevationGridDivision,
    layoutElevationNotes,
    sameBeat,
    snapElevation,
    type ElevationNote,
} from '../../src/editor/elevation/layout'
import { elevationViewport, fitElevationViewport } from '../../src/editor/elevation/viewport'
import type { SlideId } from '../../src/state/entities/slides'
import type { NoteEntity } from '../../src/state/entities/slides/note'

const note = (slide: number, order: number, lane = 0, elevation = 0): ElevationNote => ({
    note: { slideId: slide as SlideId } as NoteEntity,
    lane,
    size: 1,
    elevation,
    attached: false,
    order,
})
const viewport = {
    width: 600,
    height: 600,
    laneLeft: -10,
    laneScale: 30,
    elevationCenter: 2.5,
    elevationScale: 100,
}

test('grid lines follow the elevation snap, thinned to stay readable', () => {
    // Each snap step while lines stay at least 15px apart.
    assert.equal(elevationGridDivision(120, 8), 8)
    assert.equal(elevationGridDivision(240, 16), 16)
    assert.equal(elevationGridDivision(120, 2), 2)
    // Too dense: halved, so lines still fall on snap points.
    assert.equal(elevationGridDivision(120, 16), 8)
    assert.equal(elevationGridDivision(120, 64), 8)
    assert.equal(elevationGridDivision(40, 8), 2)
    assert.equal(elevationGridDivision(20, 8), 1)
    assert.equal(elevationGridDivision(5, 8), 1)
    assert.equal(elevationGridDivision(5, 1), 1)
    // Snap off keeps the zoom-based lines.
    assert.equal(elevationGridDivision(120, 0), 8)
    assert.equal(elevationGridDivision(60, 0), 4)
    assert.equal(elevationGridDivision(59, 0), 1)
    // A 1/8 snap matches the zoom-based lines down to 60px per unit.
    for (const scale of [60, 90, 119, 120, 180, 400]) {
        assert.equal(elevationGridDivision(scale, 8), elevationGridDivision(scale, 0), `${scale}`)
    }
})

test('overlapping notes stay at their actual elevation', () => {
    const layout = layoutElevationNotes([note(1, 0), note(2, 0), note(3, 0)], viewport)
    assert.equal(layout.rows.length, 3)
    assert.equal(new Set(layout.rows.map((row) => row.y)).size, 1)
    for (const row of layout.rows) {
        assert.equal(row.y, layout.yAt(0))
        assert.equal(row.x, layout.xAt(0))
    }
})

test('same-elevation slide notes stay level regardless of connection order', () => {
    const layout = layoutElevationNotes([note(1, 2, 5), note(1, 0, -5), note(1, 1, 0)], viewport)
    const rows = [...layout.rows].sort((a, b) => a.order - b.order)
    assert.equal(rows.length, 3)
    assert.equal(rows[0]!.y, rows[1]!.y)
    assert.equal(rows[0]!.y, rows[2]!.y)
})

test('the elevation viewport maps fixed units without shifting the axis during an edit', () => {
    const before = layoutElevationNotes([note(1, 0, 0, 2)], viewport)
    const after = layoutElevationNotes([note(1, 0, 0, 2.25)], viewport)
    assert.equal(before.yAt(0), after.yAt(0))
    assert.equal(before.yAt(0) - before.yAt(5), 500)
    assert.equal(before.rows[0]!.y - after.rows[0]!.y, 25)
    assert.equal(before.xAt(2) - before.xAt(0), 60)
})

test('beat matching includes arithmetic round trips and excludes nearby notes', () => {
    assert.ok(sameBeat(1 / 3, 1 / 3 + 1e-12))
    assert.ok(!sameBeat(4, 4.0001))
})

test('elevation snapping supports eighths, negative values, and disabling snapping', () => {
    assert.equal(snapElevation(0.18, 8), 0.125)
    assert.equal(snapElevation(-0.18, 8), -0.125)
    assert.equal(snapElevation(0.18, 0), 0.18)
})

test('initial elevation fitting keeps the scale and centres on 3, keeping 0 and then the notes in view', () => {
    const saved = { ...elevationViewport }
    // At 38px per elevation, the band between the paddings reaches 220px above the
    // centre and 160px below; notes keep 0.3 from its edges, and 0 keeps 16px off its bottom.
    const above = 220 / 38
    const below = 160 / 38
    const centre = (elevations: number[], height = 600) => {
        fitElevationViewport(
            height,
            elevations.map((elevation, i) => note(i, 0, 0, elevation)),
            38,
            undefined,
            0.3 * 38,
        )
        assert.equal(elevationViewport.scale, 38)
        return elevationViewport.center
    }
    const close = (actual: number, expected: number) =>
        assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`)
    try {
        close(centre([]), 3)
        close(centre([0, 2, 5]), 3)
        // The top note sets the lowest centre.
        close(centre([1, 9]), 9 - above + 0.3)
        // Notes far above: 0 stays 16px over the bottom, as near them as that allows.
        close(centre([40, 45]), below - 16 / 38)
        // Notes below: the bottom note sets the highest centre.
        close(centre([-4, -1]), -4 + below - 0.3)
        // Notes far below: 0 stays at the top, as near them as that allows.
        close(centre([-40]), -above)
        // A 100px pane's band is 10px: 0 is halfway between its two limits.
        close(centre([], 100), (30 / 38 + 40 / 38 - 16 / 38) / 2)
        close(centre([20], 100), (30 / 38 + 40 / 38 - 16 / 38) / 2)
    } finally {
        Object.assign(elevationViewport, saved)
    }
})
