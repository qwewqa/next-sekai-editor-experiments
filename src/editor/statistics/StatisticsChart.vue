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
import { i18n } from '../../i18n'
import {
    CATEGORIES,
    chartModel,
    fillMessage,
    formatList,
    oneSecondMax,
    timeTicks,
    type Category,
    type ChartMode,
    type Figures,
} from '../../levelData/statistics'
import { chartCategoryColors } from '../../modals/form/noteShapes'
import { settings } from '../../settings'
import type { BpmIntegral } from '../../state/integrals/bpms'
import { timeToBeat } from '../../state/integrals/bpms'
import { formatIntegerTime, formatTime } from '../../utils/format'
import { formatCount, formatDecimal, formatTenths } from '../../utils/size'
import { formatBeatPosition } from '../beatDisplay'
import { drawChart, readAt, type Reading } from './drawing'
import { statisticsLocale, statisticsStrings } from './text'

// Notes per Second: the mode control, the plot with its readout on the label line above it,
// the legend that chooses the categories, and the four figures.

const props = defineProps<{
    /** Each category's sorted times. */
    times: Record<Category, Float64Array>
    /** Every category's times, merged: the grid and the timeline follow the chart. */
    every: Float64Array
    bgmEnd: number | undefined
    bpms: BpmIntegral[]
    figures: Figures | undefined
    /** False at absurd BPMs: the plot stays empty and the figures are left out. */
    drawable: boolean
    /** The dialog's scrolling body, for the sticky label line and the plot's place on screen. */
    scroller: HTMLElement | undefined
}>()

const strings = statisticsStrings
const locale = statisticsLocale
const headingId = useId()
const modeName = useId()

const mode = computed({
    get: () => settings.statisticsChart,
    set: (value: ChartMode) => (settings.statisticsChart = value),
})
const chosen = computed(() => settings.statisticsDensityTypes)
const isOn = (category: Category) => chosen.value.includes(category)

const status = ref('')
const toggle = (category: Category, on: boolean) => {
    const set = new Set(chosen.value)
    if (on) set.add(category)
    else set.delete(category)
    settings.statisticsDensityTypes = CATEGORIES.filter((each) => set.has(each))
    // After a toggle, one polite line says the new Average.
    void nextTick(() => {
        const figures = props.figures
        status.value = figures
            ? fillMessage(
                  locale.value,
                  strings.value.textLine,
                  strings.value.average,
                  formatTenths(figures.average, locale.value),
              )
            : strings.value.noNotes
    })
}

// --- The legend's layout follows the viewport's width only.
const sideQuery = matchMedia('(min-width: 1024px)')
const side = ref(sideQuery.matches)
const onSide = () => (side.value = sideQuery.matches)
sideQuery.addEventListener('change', onSide)
const legendOrder = computed(() => (side.value ? [...CATEGORIES].reverse() : CATEGORIES))

// --- The plot's size and its place on the device pixel grid.
const chart = useTemplateRef<HTMLDivElement>('chart')
const plotBlock = useTemplateRef<HTMLDivElement>('plotBlock')
const size = shallowRef({ width: 0, height: 0 })
const dpr = ref(window.devicePixelRatio || 1)
const chartLeft = ref(0)

const measurePlot = () => {
    const element = chart.value
    if (!element) return
    const box = element.getBoundingClientRect()
    dpr.value = window.devicePixelRatio || 1
    if (box.width !== size.value.width || box.height !== size.value.height)
        size.value = { width: box.width, height: box.height }
    const block = plotBlock.value
    if (block) chartLeft.value = box.left - block.getBoundingClientRect().left
}

// --- The model and its drawing.
const chosenTimes = computed(() => CATEGORIES.filter(isOn).map((category) => props.times[category]))
const kinds = computed(() => CATEGORIES.filter(isOn))
const hasNotes = computed(() => chosenTimes.value.some((list) => list.length > 0))
const columns = computed(() => Math.max(2, Math.round(size.value.width * 2)))

const model = computed(() => {
    if (!props.drawable || !hasNotes.value || !size.value.width) return undefined
    return chartModel(
        mode.value,
        props.every,
        chosenTimes.value,
        props.bgmEnd,
        mode.value === 'smooth' ? columns.value : 2,
    )
})

const drawing = computed(() => {
    const current = model.value
    if (!current || !size.value.height) return undefined
    return drawChart(current, size.value.width, size.value.height, dpr.value)
})

const ink = computed(() => mode.value === 'rolling')

const xTicks = computed(() => {
    const current = model.value
    if (!current) return []
    const wide = new Set(timeTicks(current.x1, 6))
    const narrow = new Set(timeTicks(current.x1, 3))
    return [...new Set([...wide, ...narrow])]
        .sort((a, b) => a - b)
        .map((time) => ({
            time,
            left: ((time - current.x0) / (current.x1 - current.x0)) * 100,
            wide: wide.has(time),
            narrow: narrow.has(time),
        }))
})

const bgmLine = computed(() => {
    const current = drawing.value
    if (!current || props.bgmEnd === undefined) return undefined
    return current.snapX(current.px(props.bgmEnd)) + current.gridWidth / 2
})

// --- The readout.
const cursor = ref<number>()
let pinned = false
const focusRing = ref(false)

const readingAt = (time: number | undefined): (Reading & { time: number }) | undefined => {
    const current = model.value
    const drawn = drawing.value
    if (time === undefined || !current || !drawn) return undefined
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
        ? fillMessage(
              locale.value,
              i18n.value.statistics.span,
              formatTime(shown.span[0]),
              formatTime(shown.span[1]),
          )
        : formatTime(shown.time)
    const parts = Object.fromEntries(
        kinds.value.map((category, j) => [category, number(shown.parts[j] ?? 0, shown.exact)]),
    ) as Partial<Record<Category, string>>
    // The value at its time, then each part, in the locale's list.
    const valueText = formatList(
        [
            fillMessage(locale.value, i18n.value.statistics.at, value, time),
            ...kinds.value.map((category) =>
                fillMessage(
                    locale.value,
                    strings.value.textLine,
                    strings.value.categories[category],
                    parts[category] ?? '',
                ),
            ),
        ],
        locale.value,
    )
    return { value, time, beat: position(when), parts, valueText }
}
const readout = computed(() => describe(reading.value))
// The slider's value text is the readout's, kept at the last time after the pointer leaves.
const valueText = computed(() => describe(readingAt(cursor.value ?? lastTime.value))?.valueText)

const show = (time: number) => {
    const current = model.value
    if (!current) return
    cursor.value = Math.min(Math.max(time, 0), current.x1)
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

const timeAt = (event: PointerEvent) => {
    const current = model.value
    const element = chart.value
    if (!current || !element) return 0
    const box = element.getBoundingClientRect()
    return current.x0 + ((event.clientX - box.left) / box.width) * (current.x1 - current.x0)
}
const onPointerMove = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' || pinned || (event.pointerType === 'pen' && !event.buttons))
        show(timeAt(event))
}
const onPointerDown = (event: PointerEvent) => {
    // A finger or a pen press pins the readout; a sideways drag moves it.
    if (event.pointerType === 'touch' || event.pointerType === 'pen') {
        pinned = true
        show(timeAt(event))
    }
}
const onFocus = () => {
    // Keyboard focus pins the readout; a click focuses the plot too, and the readout still follows
    // the mouse and clears when it leaves.
    if (!chart.value?.matches(':focus-visible')) return
    pinned = true
    focusRing.value = true
    show(cursor.value ?? 0)
}
const onBlur = () => {
    pinned = false
    focusRing.value = false
    hide()
}
const onKeydown = (event: KeyboardEvent) => {
    const current = model.value
    if (!current) return
    // Smooth: 1 s and 10 s. Bars: one bar and ten. Rolling: one step and ten.
    const unit = current.bins
        ? current.bins.width
        : current.steps
          ? (current.x1 - current.x0) / current.steps.length
          : 1
    const step = { ArrowLeft: -1, ArrowRight: 1, PageDown: 10, PageUp: -10 }[event.key]
    if (step !== undefined) show((cursor.value ?? 0) + step * unit)
    else if (event.key === 'Home') show(0)
    else if (event.key === 'End') show(current.x1)
    else return
    event.preventDefault()
}
watch(mode, () => {
    cursor.value = undefined
})

// --- The label line: its height is the widest readout's, measured on open and when the width
// or the shown chart changes, never during interaction.
const probe = useTemplateRef<HTMLSpanElement>('probe')
const lines = ref(1)
const top = computed(() => oneSecondMax(props.every))
const slotWidth = computed(() => formatTenths(top.value, locale.value).length)
const probeText = computed(() => {
    let end = props.bgmEnd ?? 0
    for (const time of props.every) if (Number.isFinite(time)) end = Math.max(end, time)
    end += 10
    return {
        value: formatTenths(top.value, locale.value),
        time: fillMessage(
            locale.value,
            i18n.value.statistics.span,
            formatTime(end),
            formatTime(end),
        ),
        beat: position(end),
    }
})
const fitLabelLine = async () => {
    await nextTick()
    const element = probe.value
    if (!element) return
    lines.value = Math.max(1, Math.round(element.getBoundingClientRect().height / 20))
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
let frame = 0
const onScroll = () => {
    checkStuck()
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(measurePlot)
}

let resize: ResizeObserver | undefined
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
onMounted(() => {
    resize = new ResizeObserver(() => {
        measurePlot()
        checkStuck()
    })
    if (chart.value) resize.observe(chart.value)
    if (props.scroller) resize.observe(props.scroller)
    watchZoom()
    window.addEventListener('resize', measurePlot)
    measurePlot()
    void fitLabelLine()
})
watch(
    () => props.scroller,
    (element, before) => {
        before?.removeEventListener('scroll', onScroll)
        element?.addEventListener('scroll', onScroll, { passive: true })
        if (element) resize?.observe(element)
    },
    { immediate: true },
)
onBeforeUnmount(() => {
    resize?.disconnect()
    zoom?.removeEventListener('change', onZoom)
    sideQuery.removeEventListener('change', onSide)
    window.removeEventListener('resize', measurePlot)
    props.scroller?.removeEventListener('scroll', onScroll)
    cancelAnimationFrame(frame)
})

// Tiles snap to device pixels from the plot's own origin, a quarter pixel past each edge, so
// crisp edges round the same way at any fractional place of the dialog (measured at 1x to 3x).
const bias = computed(() => 0.25 / dpr.value)
const yLabel = (value: number) => formatDecimal(Math.round(value * 1e6) / 1e6, locale.value)
const color = (category: Category) => chartCategoryColors[category]
const modes = computed(() => [
    { value: 'smooth' as const, label: i18n.value.statistics.smooth },
    { value: 'bars' as const, label: i18n.value.statistics.bars },
    { value: 'rolling' as const, label: i18n.value.statistics.rolling },
])
const figureRows = computed(() => {
    const figures = props.figures
    const value = (text: string) => (figures ? text : '')
    return [
        {
            label: strings.value.average,
            value: value(formatTenths(figures?.average ?? 0, locale.value)),
        },
        {
            label: strings.value.median,
            value: value(formatCount(figures?.median ?? 0, locale.value)),
        },
        { label: strings.value.p90, value: value(formatCount(figures?.p90 ?? 0, locale.value)) },
        { label: strings.value.p99, value: value(formatCount(figures?.p99 ?? 0, locale.value)) },
    ]
})

defineExpose({ chosen })
</script>

<template>
    <div class="stats-head">
        <h3 :id="headingId" class="font-bold">{{ strings.notesPerSecond }}</h3>
        <div
            class="flex rounded-full bg-recess p-0.5 shadow-track"
            role="radiogroup"
            :aria-labelledby="headingId"
            data-statistics-mode
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

    <div
        ref="plotBlock"
        class="stats-plot"
        :style="{ '--lines': lines, '--v': `${slotWidth}ch` }"
        data-statistics-plot
    >
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
            <span
                v-if="bgmLine !== undefined && !readout"
                class="stats-bgm-label"
                :style="{ left: `${chartLeft + bgmLine}px` }"
                data-statistics-bgm-label
                >{{ strings.bgmEnd }}</span
            >
        </div>
        <div class="stats-plot-row" :class="{ side }">
            <div
                ref="chart"
                class="stats-chart"
                :tabindex="model ? 0 : -1"
                :role="model ? 'slider' : undefined"
                :aria-labelledby="model ? headingId : undefined"
                :aria-valuemin="model ? 0 : undefined"
                :aria-valuemax="model ? Math.round(model.x1 * 1000) / 1000 : undefined"
                :aria-valuenow="model ? Math.round(lastTime * 1000) / 1000 : undefined"
                :aria-valuetext="model ? valueText : undefined"
                data-statistics-chart
                @pointermove="onPointerMove"
                @pointerdown="onPointerDown"
                @pointerleave="hide"
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
                        <path
                            :d="`M${drawing.px(model.x0)} ${drawing.py(0)} L${drawing.lines[drawing.lines.length - 1]?.slice(1)} L${drawing.px(model.x1)} ${drawing.py(0)} Z`"
                            :fill="`url(#${headingId}-wash)`"
                        />
                        <path
                            class="stats-line"
                            :d="drawing.lines[drawing.lines.length - 1]"
                            data-statistics-line
                        />
                    </template>
                    <path
                        v-if="mode !== 'rolling'"
                        class="stats-line stats-fc-only"
                        :d="drawing.lines[drawing.lines.length - 1]"
                    />
                    <line
                        v-if="bgmLine !== undefined"
                        class="stats-marker"
                        :x1="bgmLine"
                        :x2="bgmLine"
                        y1="0"
                        :y2="drawing.height"
                        :style="{ strokeWidth: `${drawing.gridWidth}px` }"
                        shape-rendering="crispEdges"
                        data-statistics-bgm-line
                    />
                </svg>
                <template v-if="drawing && model">
                    <span
                        v-for="line in drawing.grid"
                        :key="line.value"
                        class="stats-tick stats-tick-y"
                        :style="{ top: `${(drawing.py(line.value) / drawing.height) * 100}%` }"
                        >{{ yLabel(line.value) }}</span
                    >
                    <span
                        v-for="tick in xTicks"
                        :key="tick.time"
                        class="stats-tick stats-tick-x"
                        :class="{ end: tick.left > 95, wide: tick.wide, narrow: tick.narrow }"
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
            <div class="stats-key" role="group" :aria-labelledby="headingId" data-statistics-legend>
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

    <dl
        v-if="drawable"
        class="stats-rows stats-two"
        :class="{ blank: !figures }"
        data-statistics-figures
    >
        <div
            v-for="(row, i) in figureRows"
            :key="i"
            class="stats-row"
            :class="{ 'col-top': i === 2 }"
        >
            <dt>{{ row.label }}</dt>
            <dd>{{ row.value }}</dd>
        </div>
    </dl>
    <span class="sr-only" role="status" aria-live="polite">{{ status }}</span>
</template>
