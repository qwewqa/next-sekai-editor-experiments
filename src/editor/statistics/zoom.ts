import type { View } from '../../levelData/statistics'

// The timeline's zoom: a view inside the chart's whole extent, or undefined for the whole chart.
// The figures below are first estimates, kept here so they can be tuned in one place.

/** The shortest view, in seconds. */
export const MIN_SPAN = 5
/** The shortest chart that zooms, in seconds. */
export const MIN_EXTENT = 10
/** Continuous input settles this long after its last wheel event or repeated key, in ms. */
export const SETTLE_MS = 200
/** Wheel events less than this far apart, in ms, are one gesture. */
export const WHEEL_RUN_MS = 200
/** A pinch measures the fingers' horizontal distance from at least this, in CSS px. */
export const PINCH_FLOOR = 40
/** One wheel event zooms by at most this many CSS px. */
export const WHEEL_CLAMP = 35
/** A wheel line in CSS px, as the editor scrolls. */
const LINE = 20

const EPSILON = 1e-9

/** Whether the extent is long enough to zoom. */
export const zoomable = (extent: View) => extent.x1 - extent.x0 >= MIN_EXTENT

/**
 * The view inside the extent and at least MIN_SPAN wide, grown about its centre; undefined when it
 * covers the extent or the extent is too short to zoom.
 */
export const clampView = (view: View | undefined, extent: View): View | undefined => {
    if (!view || !zoomable(extent)) return undefined
    const full = extent.x1 - extent.x0
    const wanted = view.x1 - view.x0
    if (!Number.isFinite(view.x0) || !Number.isFinite(wanted)) return undefined
    const span = Math.max(wanted, MIN_SPAN)
    if (span >= full - EPSILON) return undefined
    const start = wanted < MIN_SPAN ? (view.x0 + view.x1) / 2 - span / 2 : view.x0
    const x0 = Math.min(Math.max(start, extent.x0), extent.x1 - span)
    return { x0, x1: x0 + span }
}

/** The span between MIN_SPAN and the extent's. */
const spanWithin = (span: number, extent: View) =>
    Math.min(Math.max(span, MIN_SPAN), extent.x1 - extent.x0)

/** Zooms by `factor` (above 1 zooms in) with `anchor` keeping its place on the plot. */
export const zoomAt = (view: View | undefined, extent: View, anchor: number, factor: number) => {
    const from = view ?? extent
    const fraction = (anchor - from.x0) / (from.x1 - from.x0)
    const span = spanWithin((from.x1 - from.x0) / factor, extent)
    const x0 = anchor - fraction * span
    return clampView({ x0, x1: x0 + span }, extent)
}

/** Moves the view by `dt` seconds, stopping at the extent's ends. */
export const panBy = (view: View | undefined, extent: View, dt: number) =>
    view && clampView({ x0: view.x0 + dt, x1: view.x1 + dt }, extent)

/** The view moved the least distance that brings `time` into it. */
export const follow = (view: View | undefined, extent: View, time: number) => {
    if (!view) return undefined
    if (time < view.x0) return panBy(view, extent, time - view.x0)
    if (time > view.x1) return panBy(view, extent, time - view.x1)
    return view
}

/**
 * A two-finger pinch: the view in which each starting time lies under its finger, from the start
 * view and the fingers' plot x now. The fingers' horizontal distance counts from PINCH_FLOOR, so
 * fingers stacked vertically only pan.
 */
export const pinchView = (
    start: View | undefined,
    extent: View,
    startTimes: readonly [number, number],
    xs: readonly [number, number],
    width: number,
) => {
    const from = start ?? extent
    const startSpan = from.x1 - from.x0
    const startXs = startTimes.map((time) => ((time - from.x0) / startSpan) * width)
    const before = Math.max(Math.abs((startXs[1] ?? 0) - (startXs[0] ?? 0)), PINCH_FLOOR)
    const now = Math.max(Math.abs(xs[1] - xs[0]), PINCH_FLOOR)
    const span = spanWithin((startSpan * before) / now, extent)
    const x0 = (startTimes[0] + startTimes[1]) / 2 - ((xs[0] + xs[1]) / 2 / width) * span
    return clampView({ x0, x1: x0 + span }, extent)
}

/** A wheel event's deltas in CSS px: lines are 20 px and pages `page` px. */
export const wheelPixels = (
    event: Pick<WheelEvent, 'deltaMode' | 'deltaX' | 'deltaY'>,
    page: number,
) => {
    // Firefox reports lines only to a listener that reads the mode before the deltas.
    const mode = event.deltaMode
    const unit = mode === 1 ? LINE : mode === 2 ? page : 1
    return { x: event.deltaX * unit, y: event.deltaY * unit }
}

/** The zoom of one wheel event, in proportion to its distance: above 1 zooms in. */
export const wheelZoomFactor = (dy: number) =>
    Math.exp(-Math.max(-WHEEL_CLAMP, Math.min(WHEEL_CLAMP, dy)) / 100)

export type WheelIntent = 'zoom' | 'pan' | 'pass'

/**
 * What a wheel event does. Ctrl and Cmd always zoom; otherwise a run of events keeps the intent
 * of its first, `latched`: a sideways or Shift run pans a zoomed view, and anything else passes to
 * the dialog.
 */
export const wheelIntent = (
    event: Pick<
        WheelEvent,
        'ctrlKey' | 'metaKey' | 'shiftKey' | 'deltaX' | 'deltaY' | 'cancelable'
    >,
    zoomed: boolean,
    latched: 'pan' | 'pass' | undefined,
): WheelIntent => {
    if (event.ctrlKey || event.metaKey) return 'zoom'
    if (latched) return latched
    const sideways =
        Math.abs(event.deltaX) > Math.abs(event.deltaY) || (event.shiftKey && event.deltaY !== 0)
    return zoomed && sideways && event.cancelable ? 'pan' : 'pass'
}

export type GestureSource = 'wheel' | 'gesture' | 'pinch' | 'drag'

/**
 * Whether `source` may drive the view while `owner` drives it. A two-finger pinch on the plot
 * outranks Safari's gesture events, which drive it only with no finger down; the wheel and a
 * mouse drag go to whichever started first.
 */
export const mayDrive = (
    owner: GestureSource | undefined,
    source: GestureSource,
    touches: number,
) => {
    if (source === 'pinch') return owner === undefined || owner === 'gesture' || owner === 'pinch'
    if (source === 'gesture') return touches === 0 && (owner === undefined || owner === 'gesture')
    return owner === undefined || owner === source
}
