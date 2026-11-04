<script setup lang="ts">
import {
    computed,
    nextTick,
    onBeforeUnmount,
    onMounted,
    ref,
    shallowRef,
    useId,
    useTemplateRef,
    watch,
} from 'vue'
import { isAppActive } from '../../activity'
import { i18n } from '../../i18n'
import {
    CATEGORIES,
    chartExtent,
    chartSource,
    chartView,
    figureRows,
    formatList,
    gridOf,
    oneSecondMax,
    timeTicks,
    type Category,
    type ChartMode,
    type NpsFigures,
    type View,
} from '../../levelData/statistics'
import { segmentsLayout, type SegmentsLayout } from '../../modals/form/segmented'
import { settings } from '../../settings'
import type { BpmIntegral } from '../../state/integrals/bpms'
import { timeToBeat } from '../../state/integrals/bpms'
import { formatIntegerTime, formatTime } from '../../utils/format'
import { fill } from '../../utils/interpolate'
import { formatCount, formatTenths } from '../../utils/size'
import { formatBeatPosition } from '../beatDisplay'
import ZoomXInIcon from '../commands/zooms/ZoomXInIcon.vue'
import ZoomXOutIcon from '../commands/zooms/ZoomXOutIcon.vue'
import { resizeEscapes } from '../controls/escapes'
import ChevronIcon from '../workspace/ChevronIcon.vue'
import { drawChart, readAt, timeLabelAlign, yLabel, type Reading } from './drawing'
import { chartCategoryColors } from './marks'
import { statisticsStrings } from './text'
import {
    clampView,
    follow,
    mayDrive,
    MIN_SPAN,
    panBy,
    pinchView,
    SETTLE_MS,
    WHEEL_RUN_MS,
    wheelIntent,
    wheelPanPixels,
    wheelPixels,
    wheelZoomFactor,
    zoomable as canZoom,
    zoomAt,
    type GestureSource,
} from './zoom'

// Notes per Second: the zoom buttons and the mode control, the plot with its readout on the label
// line above it, and the legend that chooses the categories.

const props = defineProps<{
    /** Each category's sorted times. */
    times: Record<Category, Float64Array>
    /** Every category's times, merged: the grid and the timeline follow the chart. */
    every: Float64Array
    bpms: BpmIntegral[]
    /** The figures, for the line a legend toggle announces. */
    figures: NpsFigures | undefined
    /** False at absurd BPMs: the plot stays empty. */
    drawable: boolean
    /** The dialog's scrolling body, for the sticky label line. */
    scroller: HTMLElement | undefined
}>()

const strings = statisticsStrings
const locale = computed(() => settings.locale)
const headingId = useId()
const modeName = useId()

const mode = computed({
    get: () => settings.statisticsChartMode,
    set: (value: ChartMode) => (settings.statisticsChartMode = value),
})
const chosen = computed(() => settings.statisticsCategories)
const isOn = (category: Category) => chosen.value.includes(category)

const status = ref('')
/** Says `text` on the polite status line, also when it is the same as last time. */
const announce = async (text: string) => {
    status.value = ''
    await nextTick()
    status.value = text
}
const toggle = (category: Category, on: boolean) => {
    const set = new Set(chosen.value)
    if (on) set.add(category)
    else set.delete(category)
    settings.statisticsCategories = CATEGORIES.filter((each) => set.has(each))
    if (!owner) settle()
    // After a toggle, one polite line says the new Average.
    void nextTick(() => {
        const [average] = figureRows(props.figures, strings.value, locale.value)
        status.value = average?.text ?? strings.value.noNotes
    })
}

// --- The legend's layout follows the viewport's width only.
const sideQuery = matchMedia('(min-width: 1024px)')
const side = ref(sideQuery.matches)
const onSide = () => (side.value = sideQuery.matches)
sideQuery.addEventListener('change', onSide)
const legendOrder = computed(() => (side.value ? [...CATEGORIES].reverse() : CATEGORIES))

// --- The plot's size and the device pixel ratio.
const chart = useTemplateRef<HTMLDivElement>('chart')
const plotBlock = useTemplateRef<HTMLDivElement>('plotBlock')
const size = shallowRef({ width: 0, height: 0 })
const dpr = ref(window.devicePixelRatio || 1)

const measurePlot = () => {
    const element = chart.value
    if (!element) return
    const box = element.getBoundingClientRect()
    dpr.value = window.devicePixelRatio || 1
    if (box.width !== size.value.width || box.height !== size.value.height)
        size.value = { width: box.width, height: box.height }
}

// --- The whole timeline, the view and the model.
const kinds = computed(() => CATEGORIES.filter(isOn))
const chosenTimes = computed(() => kinds.value.map((category) => props.times[category]))
const hasNotes = computed(() => chosenTimes.value.some((list) => list.length > 0))
const columns = computed(() => Math.max(2, Math.round(size.value.width * 2)))

const grid = computed(() => (props.drawable ? gridOf(props.every) : undefined))
const source = computed(
    () => grid.value && chartSource(props.every, chosenTimes.value, undefined, grid.value),
)
let lastExtent: View | undefined
/** The mode's whole timeline; the same object while its ends stay. */
const extent = computed(() => {
    const current = source.value && chartExtent(mode.value, source.value)
    if (current?.x0 !== lastExtent?.x0 || current?.x1 !== lastExtent?.x1) lastExtent = current
    return lastExtent
})
const zoomable = computed(() => !!extent.value && canZoom(extent.value))

/** The view asked for, in seconds, or undefined for the whole chart. It lasts while the dialog is open. */
const viewWanted = shallowRef<View>()
const view = computed(() => extent.value && clampView(viewWanted.value, extent.value))
// A change to the chart keeps the view clamped, so an old place cannot come back when it grows.
watch(extent, (current) => {
    if (current) viewWanted.value = clampView(viewWanted.value, current)
})
const sameView = (a: View | undefined, b: View | undefined) =>
    a === b || (!!a && !!b && a.x0 === b.x0 && a.x1 === b.x1)

/** The span Rolling's steps and Bars' bins follow, set when input settles; undefined is the whole. */
const settledSpan = ref<number>()
/** The y axis's lowest top while input goes on: the highest drawn since it started. */
const held = ref(0)

const model = computed(() => {
    const current = source.value
    const full = extent.value
    if (!current || !full || !hasNotes.value || !size.value.width) return undefined
    const shown = view.value
    return chartView(
        mode.value,
        current,
        mode.value === 'smooth' ? columns.value : 2,
        shown,
        shown && (settledSpan.value ?? full.x1 - full.x0),
    )
})

const drawing = computed(() => {
    const current = model.value
    if (!current || !size.value.height) return undefined
    return drawChart(current, size.value.width, size.value.height, dpr.value, 4, held.value)
})

const ink = computed(() => mode.value === 'rolling')

const xTicks = computed(() => {
    const current = model.value
    const drawn = drawing.value
    if (!current || !drawn) return []
    const wide = new Set(timeTicks(current.x1, 6, current.x0))
    const narrow = new Set(timeTicks(current.x1, 3, current.x0))
    return [...new Set([...wide, ...narrow])]
        .sort((a, b) => a - b)
        .map((time) => ({
            time,
            left: ((time - current.x0) / (current.x1 - current.x0)) * 100,
            align: timeLabelAlign(drawn.px(time), drawn.width),
            wide: wide.has(time),
            narrow: narrow.has(time),
        }))
})

// --- The readout.
const cursor = ref<number>()
let pinned = false
const focusRing = ref(false)

/** The values at a time in the view. */
const readingAt = (time: number | undefined): (Reading & { time: number }) | undefined => {
    const current = model.value
    const drawn = drawing.value
    if (time === undefined || !current || !drawn) return undefined
    if (time < current.x0 - 1e-9 || time > current.x1 + 1e-9) return undefined
    return { ...readAt(current, drawn, time), time }
}
const reading = computed(() => readingAt(cursor.value))

const number = (value: number, exact: boolean) =>
    exact ? formatCount(value, locale.value) : formatTenths(value, locale.value)

const position = (time: number) =>
    formatBeatPosition(
        props.bpms,
        timeToBeat(props.bpms, Math.max(0, time)),
        settings.beatDisplay,
        true,
    )

const describe = (shown: (Reading & { time: number }) | undefined) => {
    if (!shown) return undefined
    const value = number(shown.exact ? shown.value : Math.round(shown.value * 10) / 10, shown.exact)
    const when = shown.span ? shown.span[0] : shown.time
    const time = shown.span
        ? fill(
              i18n.value.statistics.span,
              [formatTime(shown.span[0]), formatTime(shown.span[1])],
              locale.value,
          )
        : formatTime(shown.time)
    const parts = Object.fromEntries(
        kinds.value.map((category, j) => [category, number(shown.parts[j] ?? 0, shown.exact)]),
    ) as Partial<Record<Category, string>>
    // The value at its time, then each part, in the locale's list.
    const valueText = formatList(
        [
            fill(i18n.value.statistics.at, [value, time], locale.value),
            ...kinds.value.map((category) =>
                fill(
                    strings.value.textLine,
                    [strings.value.categories[category], parts[category] ?? ''],
                    locale.value,
                ),
            ),
        ],
        locale.value,
    )
    return { value, time, beat: position(when), parts, valueText }
}
const readout = computed(() => describe(reading.value))

/** Shows the readout at a time within `bounds`: the view for a pointer, the whole for a key. */
const show = (time: number, bounds: View | undefined = model.value) => {
    if (!model.value || !bounds) return
    cursor.value = Math.min(Math.max(time, Math.max(0, bounds.x0)), bounds.x1)
}
const hide = () => {
    if (pinned) return
    cursor.value = undefined
}
// The last time, kept for aria-valuenow after the pointer leaves.
const lastTime = ref(0)
watch(cursor, (time) => {
    if (time !== undefined) lastTime.value = time
})
// The slider's value and its text: the readout's time, kept after the pointer leaves, and within
// the view when a pan has moved past it.
const valueNow = computed(() => {
    const current = model.value
    const time = cursor.value ?? lastTime.value
    return current ? Math.min(Math.max(time, Math.max(0, current.x0)), current.x1) : 0
})
const valueText = computed(() => describe(readingAt(valueNow.value))?.valueText)
// With no plot the readout clears; the view and the place the buttons zoom on stay. A pan that
// moves past a pinned readout takes it along at the view's edge, where the slider says it is; a
// hover readout left outside the view hides until the pointer moves.
watch(model, (current) => {
    if (!current) cursor.value = undefined
    else if (pinned && cursor.value !== undefined && cursor.value !== valueNow.value)
        cursor.value = valueNow.value
})

/** The time under a client x, in the drawn view or in `from`. */
const timeAtX = (clientX: number, from: View | undefined = model.value) => {
    const element = chart.value
    if (!from || !element) return 0
    const box = element.getBoundingClientRect()
    return from.x0 + ((clientX - box.left) / box.width) * (from.x1 - from.x0)
}

// --- Zoom and pan. One source drives the view at a time. Its handlers queue a view, and one
// animation frame shows it. While input goes on the y axis only rises; when it ends, the y axis,
// Rolling's steps and Bars' bins settle.

/** The last place a click, a tap, a pen press or the keyboard chose: the buttons zoom there. */
let pinTime: number | undefined
let owner: GestureSource | undefined
let pending: { view: View | undefined } | undefined
let frame = 0
let settleTimer: ReturnType<typeof setTimeout> | undefined
let wheelRun: { latched: 'pan' | 'pass' | undefined; last: number } | undefined
/** A mouse press: a click unless it moves 4 px; while zoomed, a drag that pans from `view`. */
let press: { id: number; x: number; moved: boolean; view: View | undefined } | undefined
const dragging = ref(false)
/** The fingers on the plot and their client x. */
const touches = new Map<number, number>()
let pinch: { ids: [number, number]; view: View | undefined; times: [number, number] } | undefined
/** After a pinch, or a zoom from elsewhere during one, until every finger lifts. */
let touchInert = false
let safari: { view: View | undefined; anchor: number } | undefined

/** The view as the next frame shows it. */
const currentView = () => (pending ? pending.view : view.value)

const cancelFrame = () => {
    if (frame) cancelAnimationFrame(frame)
    frame = 0
}
const commit = () => {
    cancelFrame()
    if (!pending) return
    viewWanted.value = pending.view
    pending = undefined
}
/** Continuous input: the view on the next frame, the y top held at the highest drawn. */
const queue = (next: View | undefined) => {
    held.value = Math.max(held.value, drawing.value?.yTop ?? 0)
    pending = { view: next }
    frame ||= requestAnimationFrame(commit)
}
const settle = () => {
    clearTimeout(settleTimer)
    settleTimer = undefined
    held.value = 0
    const shown = view.value
    settledSpan.value = shown && shown.x1 - shown.x0
}
const settleLater = () => {
    clearTimeout(settleTimer)
    settleTimer = setTimeout(() => {
        complete()
    }, SETTLE_MS)
}
const escapeDrag = () => {
    if (owner !== 'drag' || !press) return
    const id = press.id
    complete({ back: { view: press.view } })
    if (chart.value?.hasPointerCapture(id)) chart.value.releasePointerCapture(id)
}
/**
 * Ends the active gesture: shows its queued view, or drops it and puts `back` back, then settles.
 * Fingers still down after a pinch, or after a zoom from elsewhere (`freeze`), do nothing more
 * until every finger lifts.
 */
const complete = ({
    back,
    freeze = false,
}: { back?: { view: View | undefined }; freeze?: boolean } = {}) => {
    if (touches.size && (pinch || freeze)) touchInert = true
    if (back) {
        cancelFrame()
        pending = undefined
        viewWanted.value = back.view
    } else commit()
    owner = undefined
    press = undefined
    dragging.value = false
    pinch = undefined
    safari = undefined
    wheelRun = undefined
    resizeEscapes.delete(escapeDrag)
    settle()
}

const zoomShown = computed(() => !!model.value && zoomable.value)
const zoomOutDisabled = computed(() => !view.value)
const zoomInDisabled = computed(
    () => !!view.value && view.value.x1 - view.value.x0 <= MIN_SPAN + 1e-6,
)

/** A button, a key or a double-click: ends any gesture, then shows `next` and says its span. */
const zoomTo = (next: (from: View | undefined, full: View) => View | undefined) => {
    const full = extent.value
    if (!full || !zoomShown.value) return
    complete({ freeze: true })
    const before = view.value
    viewWanted.value = next(before, full)
    settle()
    const after = view.value
    if (sameView(before, after)) return
    const shown = after ?? full
    void announce(
        fill(
            i18n.value.statistics.span,
            [formatTime(Math.max(0, shown.x0)), formatTime(shown.x1)],
            locale.value,
        ),
    )
}
/** A zoom button, or with `key` a zoom key, which first ends any gesture and then checks the limit. */
const zoomBy = (factor: number, key = false) => {
    if (key) complete({ freeze: true })
    // Enter and Space still click a button marked disabled.
    if (factor > 1 ? zoomInDisabled.value : zoomOutDisabled.value) return
    zoomTo((from, full) => {
        const shown = from ?? full
        const anchor =
            pinTime !== undefined && pinTime >= shown.x0 && pinTime <= shown.x1
                ? pinTime
                : (shown.x0 + shown.x1) / 2
        return zoomAt(from, full, anchor, factor)
    })
}
const showAll = () => {
    zoomTo(() => undefined)
}

const onWheel = (event: WheelEvent) => {
    const element = chart.value
    if (!model.value || !element) return
    // Over a drawn plot, Ctrl+wheel and a trackpad pinch never zoom the page.
    if (event.ctrlKey || event.metaKey) event.preventDefault()
    const full = extent.value
    if (!full || !zoomable.value) return
    if (wheelRun && event.timeStamp - wheelRun.last > WHEEL_RUN_MS) wheelRun = undefined
    const intent = wheelIntent(event, !!currentView(), wheelRun?.latched)
    wheelRun = { latched: intent === 'zoom' ? wheelRun?.latched : intent, last: event.timeStamp }
    if (intent === 'pass' || !mayDrive(owner, 'wheel', touches.size)) return
    owner = 'wheel'
    event.preventDefault()
    const box = element.getBoundingClientRect()
    const d = wheelPixels(event, box.width)
    const from = currentView()
    const shown = from ?? full
    const span = shown.x1 - shown.x0
    if (intent === 'zoom') {
        const anchor = shown.x0 + ((event.clientX - box.left) / box.width) * span
        queue(zoomAt(from, full, anchor, wheelZoomFactor(d.y)))
    } else {
        queue(panBy(from, full, (wheelPanPixels(d, event.shiftKey) / box.width) * span))
    }
    settleLater()
}

let lastPointerType = ''
const onPointerDown = (event: PointerEvent) => {
    lastPointerType = event.pointerType
    if (event.pointerType === 'mouse') {
        if (event.button !== 0) return
        press = { id: event.pointerId, x: event.clientX, moved: false, view: view.value }
        if (view.value && mayDrive(owner, 'drag', touches.size)) {
            owner = 'drag'
            chart.value?.setPointerCapture(event.pointerId)
            resizeEscapes.add(escapeDrag)
        }
        return
    }
    if (event.pointerType === 'touch') {
        touches.set(event.pointerId, event.clientX)
        if (touches.size === 2) {
            // Two fingers never move the readout between them.
            pinned = false
            cursor.value = undefined
            if (!touchInert) startPinch()
        }
        if (touches.size > 1 || touchInert) return
    }
    // A finger or a pen press pins the readout; a sideways drag moves it.
    pinned = true
    show(timeAtX(event.clientX))
    pinTime = cursor.value
}
const startPinch = () => {
    const full = extent.value
    const [a, b] = [...touches.keys()]
    if (!full || a === undefined || b === undefined) return
    if (!zoomShown.value || !mayDrive(owner, 'pinch', touches.size)) return
    if (owner) complete()
    const from = currentView()
    owner = 'pinch'
    pinch = {
        ids: [a, b],
        view: from,
        times: [
            timeAtX(touches.get(a) ?? 0, from ?? full),
            timeAtX(touches.get(b) ?? 0, from ?? full),
        ],
    }
}
const drag = (event: PointerEvent) => {
    const full = extent.value
    const element = chart.value
    if (!press || !full || !element) return
    const dx = event.clientX - press.x
    if (!press.moved && Math.abs(dx) < 4) return
    press.moved = true
    dragging.value = true
    const from = press.view ?? full
    queue(
        panBy(
            press.view,
            full,
            (-dx / element.getBoundingClientRect().width) * (from.x1 - from.x0),
        ),
    )
}
const movePinch = () => {
    const full = extent.value
    const element = chart.value
    if (!pinch || !full || !element) return
    const box = element.getBoundingClientRect()
    const xs = pinch.ids.map((id) => (touches.get(id) ?? 0) - box.left) as [number, number]
    queue(pinchView(pinch.view, full, pinch.times, xs, box.width))
}
const onPointerMove = (event: PointerEvent) => {
    if (event.pointerType === 'mouse') {
        if (press?.id === event.pointerId && owner === 'drag') {
            // A button released outside the window, as after Alt+Tab, ends the drag here.
            if ((event.buttons & 1) === 0) complete()
            else drag(event)
        }
        show(timeAtX(event.clientX))
        return
    }
    if (event.pointerType === 'touch') {
        if (!touches.has(event.pointerId)) return
        touches.set(event.pointerId, event.clientX)
        if (pinch) {
            if (pinch.ids.includes(event.pointerId)) movePinch()
            return
        }
        if (touches.size > 1 || touchInert) return
    }
    if (pinned || (event.pointerType === 'pen' && !event.buttons)) show(timeAtX(event.clientX))
}
/** A pointer lifts, or is cancelled when `click` is false. */
const release = (event: PointerEvent, click: boolean) => {
    if (event.pointerType === 'mouse') {
        if (press?.id !== event.pointerId) return
        // A click chooses the place the buttons zoom on, and leaves the readout unpinned.
        if (click && !press.moved) pinTime = timeAtX(event.clientX)
        if (owner === 'drag') complete()
        else press = undefined
        return
    }
    if (event.pointerType !== 'touch' || !touches.delete(event.pointerId)) return
    if (pinch?.ids.includes(event.pointerId)) complete()
    if (!touches.size) touchInert = false
}
const onPointerUp = (event: PointerEvent) => {
    release(event, true)
}
const onPointerCancel = (event: PointerEvent) => {
    release(event, false)
}
const onDoubleClick = () => {
    // Touch double-taps have no meaning here.
    if (lastPointerType === 'mouse') showAll()
}

// Safari's trackpad pinch on macOS and iPadOS; a pinch on the screen is the fingers' own.
type SafariGestureEvent = UIEvent & { scale: number; clientX: number }
const onGestureStart = (event: Event) => {
    event.preventDefault()
    const full = extent.value
    if (!full || !zoomShown.value || !mayDrive(owner, 'gesture', touches.size)) return
    if (owner && owner !== 'gesture') complete()
    const from = currentView()
    owner = 'gesture'
    safari = { view: from, anchor: timeAtX((event as SafariGestureEvent).clientX, from ?? full) }
}
const onGestureChange = (event: Event) => {
    event.preventDefault()
    const full = extent.value
    const scale = (event as SafariGestureEvent).scale
    if (owner === 'gesture' && safari && full && scale > 0)
        queue(zoomAt(safari.view, full, safari.anchor, scale))
}
const onGestureEnd = (event: Event) => {
    event.preventDefault()
    if (owner === 'gesture') complete()
}
// A drift of two fingers must not start scrolling the dialog in the middle of a pinch.
const onTouchMove = (event: TouchEvent) => {
    if (event.touches.length >= 2 && event.cancelable) event.preventDefault()
}

const onFocus = () => {
    // Keyboard focus pins the readout; a click focuses the plot too, and the readout still follows
    // the mouse and clears when it leaves.
    if (!chart.value?.matches(':focus-visible')) return
    pinned = true
    focusRing.value = true
    const shown = view.value ?? extent.value
    const last = lastTime.value
    show(shown && (last < shown.x0 || last > shown.x1) ? shown.x0 : last, extent.value)
    pinTime = cursor.value
}
const onBlur = () => {
    pinned = false
    focusRing.value = false
    hide()
}
const zoomKey = (event: KeyboardEvent) => {
    // With Ctrl, Cmd or Alt they are the browser's page zoom.
    if (event.ctrlKey || event.metaKey || event.altKey) return undefined
    if (event.key === '+' || event.key === '=') return 'in'
    if (event.key === '-') return 'out'
    // By code too, for the AZERTY key that types 0 only with Shift.
    if (event.key === '0' || event.code === 'Digit0' || event.code === 'Numpad0') return 'all'
    return undefined
}
const onKeydown = (event: KeyboardEvent) => {
    const current = model.value
    const full = extent.value
    if (!current || !full) return
    const zoom = zoomKey(event)
    if (zoom && zoomable.value) {
        event.preventDefault()
        if (zoom === 'all') showAll()
        else zoomBy(zoom === 'in' ? 2 : 0.5, true)
        return
    }
    // Smooth: 1 s and 10 s. Bars: one bar and ten. Rolling: one step and ten.
    const first = current.steps?.[0]
    const unit = current.bins ? current.bins.width : first ? first.b - first.a : 1
    const step = {
        ArrowLeft: -1,
        ArrowDown: -1,
        ArrowRight: 1,
        ArrowUp: 1,
        PageDown: -10,
        PageUp: 10,
    }[event.key]
    const time =
        step !== undefined
            ? valueNow.value + step * unit
            : event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? full.x1
                : undefined
    if (time === undefined) return
    event.preventDefault()
    // A key takes over from a click: the readout is the keyboard's now, pinned and ringed, and the
    // view follows it as a text caret's line does.
    pinned = true
    focusRing.value = true
    if (owner) complete()
    show(time, full)
    pinTime = cursor.value
    if (cursor.value === undefined) return
    const next = follow(view.value, full, cursor.value)
    if (event.repeat) {
        held.value = Math.max(held.value, drawing.value?.yTop ?? 0)
        viewWanted.value = next
        settleLater()
    } else {
        viewWanted.value = next
        settle()
    }
}
watch(mode, () => {
    cursor.value = undefined
    complete()
})
// Leaving the app ends a drag; the view stays.
watch(isAppActive, (active) => {
    if (!active && owner) complete()
})

// --- The label line: its height is the widest readout's, measured on open and when the width
// or the shown chart changes, never during interaction.
const probe = useTemplateRef<HTMLSpanElement>('probe')
const lines = ref(1)
const top = computed(() => oneSecondMax(props.every))
const slotWidth = computed(() => formatTenths(top.value, locale.value).length)
const probeText = computed(() => {
    let end = 0
    for (const time of props.every) if (Number.isFinite(time)) end = Math.max(end, time)
    end += 10
    return {
        value: formatTenths(top.value, locale.value),
        time: fill(i18n.value.statistics.span, [formatTime(end), formatTime(end)], locale.value),
        beat: position(end),
    }
})
const fitLabelLine = async () => {
    await nextTick()
    const element = probe.value
    if (!element) return
    const lineHeight = parseFloat(getComputedStyle(element).lineHeight)
    if (!(lineHeight > 0)) return
    lines.value = Math.max(1, Math.round(element.getBoundingClientRect().height / lineHeight))
}
watch([probeText, () => size.value.width], fitLabelLine)

// --- Sticky: the label line is raised while it is stuck over the plot.
const labelLine = useTemplateRef<HTMLDivElement>('labelLine')
const stuck = ref(false)
const checkStuck = () => {
    const body = props.scroller
    const line = labelLine.value
    const block = plotBlock.value
    if (!body || !line || !block) return
    const edge = body.getBoundingClientRect().top
    const lineBox = line.getBoundingClientRect()
    const blockBox = block.getBoundingClientRect()
    stuck.value =
        lineBox.top <= edge + 0.5 && blockBox.top < edge - 0.5 && blockBox.bottom > lineBox.bottom
}

// --- The mode control: segments at today's padding where they fit the heading row's width, then
// at less, then a select. The labels are measured from hidden copies, so the result does not
// depend on the control shown.
const modes = computed(() => [
    { value: 'smooth' as const, label: i18n.value.statistics.smooth },
    { value: 'bars' as const, label: i18n.value.statistics.bars },
    { value: 'rolling' as const, label: i18n.value.statistics.rolling },
])
const head = useTemplateRef<HTMLDivElement>('head')
const modeProbe = useTemplateRef<HTMLSpanElement>('modeProbe')
const modeControl = useTemplateRef<HTMLElement>('modeControl')
const layout = ref<SegmentsLayout>('wide')
const fitModes = () => {
    const element = head.value
    const labels = modeProbe.value?.children
    if (!element || !labels) return
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
    layout.value = segmentsLayout(
        element.clientWidth,
        [...labels].map((label) => label.getBoundingClientRect().width),
        rem,
    )
}
// The swapped-in control keeps keyboard focus.
watch(
    () => layout.value === 'select',
    async () => {
        const focused = !!modeControl.value?.contains(document.activeElement)
        await nextTick()
        if (!focused) return
        const control = modeControl.value
        const next = control?.matches('select')
            ? control
            : control?.querySelector<HTMLElement>('input:checked')
        next?.focus({ preventScroll: true })
    },
    { flush: 'pre' },
)

let resize: ResizeObserver | undefined
let fit: ResizeObserver | undefined
let zoom: MediaQueryList | undefined
const onZoom = () => {
    watchZoom()
    measurePlot()
}
const watchZoom = () => {
    zoom?.removeEventListener('change', onZoom)
    zoom = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    zoom.addEventListener('change', onZoom)
}
// Added by hand: they must not be passive, and Vue has no names for Safari's gesture events.
const plotListeners = [
    ['gesturestart', onGestureStart],
    ['gesturechange', onGestureChange],
    ['gestureend', onGestureEnd],
    ['touchmove', onTouchMove as EventListener],
] as const
onMounted(() => {
    resize = new ResizeObserver(() => {
        measurePlot()
        checkStuck()
    })
    if (chart.value) resize.observe(chart.value)
    if (props.scroller) resize.observe(props.scroller)
    // The labels' copies change size with the locale, the root font size and font loads.
    fit = new ResizeObserver(fitModes)
    if (head.value) fit.observe(head.value)
    for (const label of modeProbe.value?.children ?? []) fit.observe(label)
    for (const [type, listener] of plotListeners)
        chart.value?.addEventListener(type, listener, { passive: false })
    watchZoom()
    measurePlot()
    fitModes()
    void fitLabelLine()
})
watch(
    () => props.scroller,
    (element, before) => {
        before?.removeEventListener('scroll', checkStuck)
        element?.addEventListener('scroll', checkStuck, { passive: true })
        if (element) resize?.observe(element)
    },
    { immediate: true },
)
onBeforeUnmount(() => {
    // Nothing queued may change the view later.
    cancelFrame()
    clearTimeout(settleTimer)
    pending = undefined
    resizeEscapes.delete(escapeDrag)
    resize?.disconnect()
    fit?.disconnect()
    for (const [type, listener] of plotListeners) chart.value?.removeEventListener(type, listener)
    zoom?.removeEventListener('change', onZoom)
    sideQuery.removeEventListener('change', onSide)
    props.scroller?.removeEventListener('scroll', checkStuck)
})

// Tiles snap to device pixels from the plot's own origin, a quarter pixel past each edge, so
// crisp edges round the same way at any fractional place of the dialog (measured at 1x to 3x).
const bias = computed(() => 0.25 / dpr.value)
const color = (category: Category) => chartCategoryColors[category]
</script>

<template>
    <div ref="head" class="stats-head">
        <span ref="modeProbe" class="stats-mode-probe" aria-hidden="true">
            <span v-for="item in modes" :key="item.value">{{ item.label }}</span>
        </span>
        <h3 :id="headingId" class="font-bold">{{ strings.notesPerSecond }}</h3>
        <!-- Always laid out, so the row does not move where the chart cannot zoom. -->
        <div class="stats-zoom" :class="{ invisible: !zoomShown }" :inert="!zoomShown">
            <button
                type="button"
                class="stats-zoom-button stats-zoom-out ghost"
                :aria-disabled="zoomOutDisabled"
                :aria-label="i18n.statistics.zoomOut"
                :title="i18n.statistics.zoomOut"
                data-statistics-zoom-out
                @click="zoomBy(0.5)"
            >
                <ZoomXOutIcon class="size-4 fill-current" aria-hidden="true" />
            </button>
            <button
                type="button"
                class="stats-zoom-button stats-zoom-in ghost"
                :aria-disabled="zoomInDisabled"
                :aria-label="i18n.statistics.zoomIn"
                :title="i18n.statistics.zoomIn"
                data-statistics-zoom-in
                @click="zoomBy(2)"
            >
                <ZoomXInIcon class="size-4 fill-current" aria-hidden="true" />
            </button>
        </div>
        <div v-if="layout === 'select'" class="stats-mode-select">
            <select
                ref="modeControl"
                v-model="mode"
                class="btn btn-secondary h-8 appearance-none rounded-full pl-4 text-sm"
                :aria-labelledby="headingId"
                data-statistics-mode-select
            >
                <option v-for="item in modes" :key="item.value" :value="item.value">
                    {{ item.label }}
                </option>
            </select>
            <span class="stats-mode-select-icon" aria-hidden="true">
                <ChevronIcon direction="down" />
            </span>
        </div>
        <div
            v-else
            ref="modeControl"
            class="flex rounded-full bg-recess p-0.5 shadow-track"
            :class="{ compact: layout === 'compact' }"
            role="radiogroup"
            :aria-labelledby="headingId"
        >
            <label v-for="item in modes" :key="item.value" class="segment-choice relative">
                <input
                    v-model="mode"
                    class="peer absolute inset-0 size-full cursor-pointer opacity-0"
                    type="radio"
                    :name="modeName"
                    :value="item.value"
                    :data-statistics-mode-option="item.value"
                />
                <span class="segment-face h-7 whitespace-nowrap px-3 text-sm">{{
                    item.label
                }}</span>
            </label>
        </div>
    </div>

    <div ref="plotBlock" class="stats-plot" :style="{ '--lines': lines, '--v': `${slotWidth}ch` }">
        <div ref="labelLine" class="stats-label-line" :class="{ stuck }">
            <span class="stats-readout" data-statistics-readout>
                <span v-if="readout" class="stats-facts">
                    <b class="stats-total">{{ readout.value }}</b>
                    <span>{{ readout.time }}</span>
                    <span class="text-fg/80">{{ readout.beat }}</span>
                </span>
            </span>
            <span ref="probe" class="stats-readout stats-probe" aria-hidden="true">
                <span class="stats-facts">
                    <b class="stats-total">{{ probeText.value }}</b>
                    <span>{{ probeText.time }}</span>
                    <span>{{ probeText.beat }}</span>
                </span>
            </span>
        </div>
        <div class="stats-plot-row" :class="{ side }">
            <div
                ref="chart"
                class="stats-chart"
                :class="{ zoomed: !!view && !!model, dragging }"
                :tabindex="model ? 0 : -1"
                :role="model ? 'slider' : undefined"
                :aria-labelledby="model ? headingId : undefined"
                :aria-valuemin="model ? 0 : undefined"
                :aria-valuemax="model && extent ? Math.round(extent.x1 * 1000) / 1000 : undefined"
                :aria-valuenow="model ? Math.round(valueNow * 1000) / 1000 : undefined"
                :aria-valuetext="model ? valueText : undefined"
                data-statistics-chart
                @pointermove="onPointerMove"
                @pointerdown="onPointerDown"
                @pointerup="onPointerUp"
                @pointercancel="onPointerCancel"
                @lostpointercapture="onPointerCancel"
                @pointerleave="hide"
                @dblclick="onDoubleClick"
                @wheel="onWheel"
                @focus="onFocus"
                @blur="onBlur"
                @keydown="onKeydown"
            >
                <span v-if="focusRing" class="stats-plot-focus" />
                <svg
                    v-if="drawing && model"
                    :viewBox="`0 0 ${drawing.width} ${drawing.height}`"
                    preserveAspectRatio="none"
                    aria-hidden="true"
                >
                    <defs>
                        <linearGradient :id="`${headingId}-wash`" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0" class="stats-wash-top" />
                            <stop offset="1" class="stats-wash-bottom" />
                        </linearGradient>
                        <!-- The data stops at the plot's sides; a peak on the top gridline keeps its stroke. -->
                        <clipPath :id="`${headingId}-clip`">
                            <rect
                                x="0"
                                y="-4"
                                :width="drawing.width"
                                :height="drawing.height + 8"
                            />
                        </clipPath>
                    </defs>
                    <line
                        v-for="line in drawing.grid"
                        :key="line.value"
                        class="stats-grid"
                        x1="0"
                        :x2="drawing.width"
                        :y1="line.y"
                        :y2="line.y"
                        :style="{ strokeWidth: `${drawing.gridWidth}px` }"
                        shape-rendering="crispEdges"
                    />
                    <g :clip-path="`url(#${headingId}-clip)`">
                        <template v-if="mode === 'smooth'">
                            <path
                                v-for="(area, j) in drawing.areas"
                                :key="kinds[j]"
                                class="stats-layer"
                                :d="area"
                                :fill="color(kinds[j]!)"
                                :data-statistics-layer="kinds[j]"
                            />
                        </template>
                        <template v-else-if="mode === 'bars'">
                            <rect
                                v-for="(tile, i) in drawing.tiles"
                                :key="i"
                                class="stats-layer"
                                :x="tile.x + bias"
                                :y="tile.y + bias"
                                :width="tile.width"
                                :height="tile.height"
                                :fill="color(kinds[tile.layer]!)"
                                :data-statistics-layer="kinds[tile.layer]"
                                shape-rendering="crispEdges"
                            />
                        </template>
                        <template v-else>
                            <path :d="drawing.wash" :fill="`url(#${headingId}-wash)`" />
                            <path class="stats-line" :d="drawing.lines[drawing.lines.length - 1]" />
                        </template>
                        <path
                            v-if="mode !== 'rolling'"
                            class="stats-line stats-fc-only"
                            :d="drawing.lines[drawing.lines.length - 1]"
                        />
                    </g>
                </svg>
                <template v-if="drawing && model">
                    <span
                        v-for="line in drawing.grid"
                        :key="line.value"
                        class="stats-tick stats-tick-y"
                        :style="{ top: `${(drawing.py(line.value) / drawing.height) * 100}%` }"
                        >{{ yLabel(line.value, locale) }}</span
                    >
                    <span
                        v-for="tick in xTicks"
                        :key="tick.time"
                        class="stats-tick stats-tick-x"
                        :class="[tick.align, { wide: tick.wide, narrow: tick.narrow }]"
                        :style="{ left: `${tick.left}%` }"
                        >{{ formatIntegerTime(tick.time) }}</span
                    >
                    <template v-if="reading">
                        <span
                            class="stats-cross"
                            :style="{
                                left: `${((reading.time - model.x0) / (model.x1 - model.x0)) * 100}%`,
                            }"
                        />
                        <span
                            class="stats-dot"
                            :style="{
                                left: `${((reading.time - model.x0) / (model.x1 - model.x0)) * 100}%`,
                                top: `${(reading.y / drawing.height) * 100}%`,
                            }"
                        />
                    </template>
                </template>
                <div v-else-if="drawable && !hasNotes" class="stats-empty" data-statistics-empty>
                    {{ strings.noNotes }}
                </div>
            </div>
            <div class="stats-key" role="group" :aria-labelledby="headingId">
                <label
                    v-for="category in legendOrder"
                    :key="category"
                    class="stats-entry"
                    :class="{ on: isOn(category) }"
                    :data-statistics-entry="category"
                >
                    <input
                        class="peer"
                        type="checkbox"
                        :checked="isOn(category)"
                        @change="toggle(category, ($event.target as HTMLInputElement).checked)"
                    />
                    <span class="stats-entry-face">
                        <span
                            class="stats-mark"
                            :class="{ ink }"
                            :style="ink ? undefined : { '--c': color(category) }"
                            aria-hidden="true"
                        />
                        <span class="stats-entry-name">{{ strings.categories[category] }}</span>
                        <span class="stats-entry-value" aria-hidden="true">{{
                            readout && isOn(category) ? readout.parts[category] : ''
                        }}</span>
                    </span>
                </label>
            </div>
        </div>
    </div>
    <span class="sr-only" role="status" aria-live="polite">{{ status }}</span>
</template>
