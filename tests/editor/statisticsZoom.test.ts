import assert from 'node:assert/strict'
import test from 'node:test'
import {
    clampView,
    follow,
    mayDrive,
    MIN_SPAN,
    panBy,
    pinchView,
    wheelIntent,
    wheelPanPixels,
    wheelPixels,
    wheelZoomFactor,
    zoomAt,
} from '../../src/editor/statistics/zoom'
import type { View } from '../../src/levelData/statistics'
import { segmentsLayout } from '../../src/modals/form/segmented'

// The timeline's zoom: the view's limits, the zoom about an anchor, panning, the pinch's mapping,
// the wheel's units and intent, and which input drives a gesture.

const extent = { x0: -1.6, x1: 120 }
const near = (a: number, b: number, tolerance = 1e-9) => Math.abs(a - b) <= tolerance
const assertView = (actual: View | undefined, x0: number, x1: number) => {
    assert.ok(actual && near(actual.x0, x0) && near(actual.x1, x1), JSON.stringify(actual))
}

test('a view stays inside the chart and at least 5 s wide, and the whole chart is no view', () => {
    assertView(clampView({ x0: -10, x1: 10 }, extent), -1.6, 18.4)
    assert.deepEqual(clampView({ x0: 110, x1: 130 }, extent), { x0: 100, x1: 120 })
    // Narrower than 5 s, it grows about its centre.
    assert.deepEqual(clampView({ x0: 50, x1: 51 }, extent), { x0: 48, x1: 53 })
    assert.equal(clampView({ x0: -1.6, x1: 120 }, extent), undefined)
    assert.equal(clampView({ x0: -5, x1: 200 }, extent), undefined)
    assert.equal(clampView(undefined, extent), undefined)
    // A chart under 10 s does not zoom.
    assert.equal(clampView({ x0: 1, x1: 6 }, { x0: 0, x1: 9.9 }), undefined)
    assert.deepEqual(clampView({ x0: 1, x1: 6 }, { x0: 0, x1: 10 }), { x0: 1, x1: 6 })
})

test('a zoom keeps its anchor in place, undoes itself, and stops at both limits', () => {
    const view = zoomAt(undefined, extent, 30, 2)
    assert.ok(view)
    const before = (30 - extent.x0) / (extent.x1 - extent.x0)
    assert.ok(near((30 - view.x0) / (view.x1 - view.x0), before))
    assert.ok(near(view.x1 - view.x0, (extent.x1 - extent.x0) / 2))
    const inner = zoomAt(view, extent, 40, 2)
    assert.ok(inner)
    const back = zoomAt(inner, extent, 40, 0.5)
    assert.ok(back && near(back.x0, view.x0) && near(back.x1, view.x1))
    // Zooming in stops at 5 s around the anchor.
    const deep = zoomAt(view, extent, 40, 1000)
    assert.ok(deep)
    assert.ok(near(deep.x1 - deep.x0, MIN_SPAN))
    assert.ok(near((40 - deep.x0) / MIN_SPAN, (40 - view.x0) / (view.x1 - view.x0)))
    // Zooming out stops at the whole chart.
    assert.equal(zoomAt(view, extent, 40, 0.1), undefined)
})

test('a pan stops at the ends; following moves the least distance', () => {
    const view = { x0: 10, x1: 30 }
    assert.deepEqual(panBy(view, extent, 5), { x0: 15, x1: 35 })
    assert.deepEqual(panBy(view, extent, 1000), { x0: 100, x1: 120 })
    assertView(panBy(view, extent, -1000), -1.6, 18.4)
    assert.equal(panBy(undefined, extent, 5), undefined)
    assert.equal(follow(view, extent, 20), view)
    assert.deepEqual(follow(view, extent, 31), { x0: 11, x1: 31 })
    assert.deepEqual(follow(view, extent, 8), { x0: 8, x1: 28 })
    assert.equal(follow(undefined, extent, 8), undefined)
})

test('a pinch keeps each starting time under its finger, and stacked fingers only pan', () => {
    const start = { x0: 20, x1: 60 }
    const width = 400
    // Fingers at 100 and 200 px: 30 s and 40 s.
    const times = [30, 40] as const
    const view = pinchView(start, extent, times, [50, 250], width)
    assert.ok(view)
    const at = (x: number) => view.x0 + (x / width) * (view.x1 - view.x0)
    assert.ok(near(at(50), 30))
    assert.ok(near(at(250), 40))
    // Fingers 10 px apart, one above the other: the span stays and the midpoint follows.
    const stacked = pinchView(start, extent, [35, 36], [160, 140], width)
    assert.ok(stacked)
    assert.ok(near(stacked.x1 - stacked.x0, 40))
    const moved = pinchView(start, extent, [35, 36], [210, 190], width)
    assert.ok(moved)
    assert.ok(near(moved.x1 - moved.x0, 40))
    assert.ok(near(moved.x0 - stacked.x0, -5))
    // From the whole chart, spreading the fingers zooms in.
    const fromWhole = pinchView(undefined, extent, [40, 80], [100, 300], width)
    assert.ok(fromWhole)
    assert.ok(fromWhole.x1 - fromWhole.x0 < extent.x1 - extent.x0)
})

test('wheel deltas become CSS px in pixel, line and page modes', () => {
    assert.deepEqual(wheelPixels({ deltaMode: 0, deltaX: 3, deltaY: -100 }, 400), { x: 3, y: -100 })
    assert.deepEqual(wheelPixels({ deltaMode: 1, deltaX: 0, deltaY: 3 }, 400), { x: 0, y: 60 })
    assert.deepEqual(wheelPixels({ deltaMode: 2, deltaX: 1, deltaY: 0 }, 400), { x: 400, y: 0 })
})

test('a wheel event zooms in proportion to its distance, up to a clamp, the same in and out', () => {
    assert.ok(near(wheelZoomFactor(100), wheelZoomFactor(35)))
    assert.ok(near(wheelZoomFactor(-100), Math.exp(0.35)))
    assert.ok(near(wheelZoomFactor(10) * wheelZoomFactor(-10), 1))
    assert.ok(wheelZoomFactor(-10) > 1)
    // A mouse notch is about half a button press: two make 2x.
    assert.ok(Math.abs(wheelZoomFactor(-100) ** 2 - 2) < 0.02)
})

test('a pan run moves by the sideways distance, and by the wheel’s turn only with Shift', () => {
    assert.equal(wheelPanPixels({ x: 10, y: 0 }, false), 10)
    // A trackpad's vertical drift during a sideways run does not move the view back.
    assert.equal(wheelPanPixels({ x: 1, y: -10 }, false), 1)
    assert.equal(wheelPanPixels({ x: 0, y: 30 }, true), 30)
    assert.equal(wheelPanPixels({ x: 30, y: 0 }, true), 30)
})

test('Ctrl and Cmd always zoom; a sideways run pans only a zoomed view and keeps its intent', () => {
    const event = (fields: Partial<Parameters<typeof wheelIntent>[0]> = {}) => ({
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        deltaX: 0,
        deltaY: 0,
        cancelable: true,
        ...fields,
    })
    assert.equal(wheelIntent(event({ ctrlKey: true, deltaY: 5 }), false, undefined), 'zoom')
    assert.equal(wheelIntent(event({ metaKey: true, deltaY: 5 }), true, 'pass'), 'zoom')
    assert.equal(wheelIntent(event({ deltaX: 10, deltaY: 2 }), true, undefined), 'pan')
    assert.equal(wheelIntent(event({ shiftKey: true, deltaY: 10 }), true, undefined), 'pan')
    assert.equal(wheelIntent(event({ deltaX: 10 }), false, undefined), 'pass')
    assert.equal(wheelIntent(event({ deltaX: 10, cancelable: false }), true, undefined), 'pass')
    assert.equal(wheelIntent(event({ deltaY: 10 }), true, undefined), 'pass')
    // A run keeps the intent of its first event, a pan at the ends of the chart too.
    assert.equal(wheelIntent(event({ deltaY: 10 }), true, 'pan'), 'pan')
    assert.equal(wheelIntent(event({ deltaX: 10 }), true, 'pass'), 'pass')
})

test('two fingers outrank every source, Safari’s gesture outranks the wheel and a drag, and those two go to the first', () => {
    for (const owner of [undefined, 'gesture', 'wheel', 'drag'] as const)
        assert.equal(mayDrive(owner, 'pinch', 2), true, owner)
    assert.equal(mayDrive('pinch', 'gesture', 2), false)
    assert.equal(mayDrive(undefined, 'gesture', 2), false)
    for (const owner of [undefined, 'gesture', 'wheel', 'drag'] as const)
        assert.equal(mayDrive(owner, 'gesture', 0), true, owner)
    assert.equal(mayDrive('wheel', 'drag', 0), false)
    assert.equal(mayDrive('drag', 'wheel', 0), false)
    assert.equal(mayDrive('gesture', 'wheel', 0), false)
    assert.equal(mayDrive('pinch', 'drag', 2), false)
    assert.equal(mayDrive('wheel', 'wheel', 0), true)
})

test('the mode control takes today’s padding, then less, then a select, by the heading row’s width', () => {
    // Labels of 50, 40 and 60 px at 16 px a rem: 150 + 3 x 16 + 4 = 202 px with px-2, 226 with px-3.
    const labels = [50, 40, 60]
    assert.equal(segmentsLayout(210, labels, 16), 'compact')
    assert.equal(segmentsLayout(226, labels, 16), 'wide')
    assert.equal(segmentsLayout(201, labels, 16), 'select')
})
