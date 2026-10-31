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
import { vScrollEdges } from '../../directives/scrollEdges'
import { state } from '../../history'
import { i18n } from '../../i18n'
import {
    bgmEndOf,
    breakdownOf,
    CATEGORIES,
    chartStatistics,
    copyTextLines,
    fillMessage,
    formatList,
    mergeTimes,
    representable,
    rollingFigures,
    ROWS,
    type Row,
} from '../../levelData/statistics'
import { showModal } from '../../modals'
import BaseModal from '../../modals/BaseModal.vue'
import NoteShapeIcon from '../../modals/form/NoteShapeIcon.vue'
import type { NoteShape } from '../../modals/form/noteShapes'
import { settings } from '../../settings'
import { formatTime } from '../../utils/format'
import { formatCount } from '../../utils/size'
import { writeText } from '../copyLink'
import { notify } from '../notification'
import SeverityIcon from '../SeverityIcon.vue'
import { useBreakdown } from './breakdown'
import ShareImageModal from './ShareImageModal.vue'
import StatisticsChart from './StatisticsChart.vue'
import { statisticsLocale, statisticsStrings } from './text'

// Statistics: the displayed chart's counts by what the player does, Notes per Second and its
// times. Read-only; it follows the displayed chart, peeks included.

const emit = defineEmits<{
    close: []
}>()

const strings = statisticsStrings
const locale = statisticsLocale

const stats = computed(() => chartStatistics({ store: state.value.store, bpms: state.value.bpms }))
const bgmEnd = computed(() => bgmEndOf(state.value.bgm))
const every = computed(
    () => mergeTimes(CATEGORIES.map((category) => stats.value.times[category])).times,
)
const drawable = computed(() => representable(stats.value, bgmEnd.value))
const chosenTimes = computed(
    () =>
        mergeTimes(
            CATEGORIES.filter((category) => settings.statisticsDensityTypes.includes(category)).map(
                (category) => stats.value.times[category],
            ),
        ).times,
)
const figures = computed(() => (drawable.value ? rollingFigures(chosenTimes.value) : undefined))

// --- The list.
const shapes: Record<Row, NoteShape> = {
    tap: 'tap',
    flick: 'flick',
    release: 'release',
    trace: 'trace',
    traceFlick: 'traceFlick',
    tick: 'tick',
    hiddenTick: 'hiddenTick',
    damageNote: 'damage',
    damageTick: 'damageTick',
    fakeNote: 'fake',
}
const rows = computed(() =>
    ROWS.map((row) => {
        const split = breakdownOf(stats.value, row)
        const lines = split && [
            { label: i18n.value.statistics.normal, value: formatCount(split.normal, locale.value) },
            {
                label: i18n.value.modals.form.isCritical.label,
                value: formatCount(split.critical, locale.value),
            },
        ]
        return {
            row,
            name: strings.value.rows[row],
            value: formatCount(stats.value.counts[row], locale.value),
            lines,
            description:
                lines &&
                formatList(
                    lines.map((line) =>
                        fillMessage(locale.value, strings.value.textLine, line.label, line.value),
                    ),
                    locale.value,
                ),
        }
    }),
)

const times = computed(() => {
    const { firstComboNote, lastComboNote, lastNote } = stats.value
    const out: { label: string; value: string }[] = []
    if (firstComboNote !== undefined)
        out.push({ label: strings.value.firstComboNote, value: formatTime(firstComboNote) })
    if (lastComboNote !== undefined)
        out.push({ label: strings.value.lastComboNote, value: formatTime(lastComboNote) })
    if (lastNote !== undefined)
        out.push({ label: strings.value.lastNote, value: formatTime(lastNote) })
    if (bgmEnd.value !== undefined)
        out.push({ label: strings.value.bgmEnd, value: formatTime(bgmEnd.value) })
    return out
})

// --- The breakdown bubble.
const bubbleId = useId()
const idBase = useId()
const listElement = useTemplateRef<HTMLElement>('list')
const bubble = useTemplateRef<HTMLElement>('bubble')
const breakdown = useBreakdown<Row>({
    inRow: (row, target) => !!target.closest(`[data-statistics-row="${row}"]`),
    inBubble: (target) => !!bubble.value?.contains(target),
})
const openRow = computed(() => {
    const open = breakdown.open.value
    return open && rows.value.find((each) => each.row === open.key && each.lines)
})
const placement = shallowRef<{ left: number; top: number }>()
watch(
    () => breakdown.open.value?.key,
    async (key) => {
        placement.value = undefined
        if (key === undefined) return
        await nextTick()
        const element = bubble.value
        const row = listElement.value?.querySelector(`[data-statistics-row="${key}"]`)
        const value = row?.querySelector('dd')
        if (!element || !row || !value) return
        // Under the row, its right edge 12 px past the value; above when there is no room below.
        const rowBox = row.getBoundingClientRect()
        const valueBox = value.getBoundingClientRect()
        const width = element.offsetWidth
        const height = element.offsetHeight
        const below = window.innerHeight - 8 - (rowBox.bottom + 4)
        placement.value = {
            left: Math.max(8, Math.min(valueBox.right + 12 - width, window.innerWidth - 8 - width)),
            top: height <= below ? rowBox.bottom + 4 : rowBox.top - 4 - height,
        }
    },
)

// --- The body: column layouts without container queries, and closing the bubble on a scroll.
const body = useTemplateRef<HTMLDivElement>('body')
const bodyElement = shallowRef<HTMLDivElement>()
const noContainerQueries = !CSS.supports('container-type', 'inline-size')
const wide = ref(false)
let observer: ResizeObserver | undefined
const onBodyScroll = () => {
    breakdown.close(true)
}
onMounted(() => {
    bodyElement.value = body.value ?? undefined
    body.value?.addEventListener('scroll', onBodyScroll, { passive: true })
    if (!noContainerQueries || !body.value) return
    const element = body.value
    // The body's content width sets the two columns, as the container query does.
    const measure = () => {
        const style = getComputedStyle(element)
        const rem = parseFloat(getComputedStyle(document.documentElement).fontSize)
        wide.value =
            element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) >=
            32 * rem
    }
    observer = new ResizeObserver(measure)
    observer.observe(element)
    measure()
})
onBeforeUnmount(() => {
    observer?.disconnect()
    body.value?.removeEventListener('scroll', onBodyScroll)
})

// --- Copy Text and Share Image.
const copyFailed = ref(false)
const copyText = () =>
    copyTextLines(
        {
            title: state.value.levelInfo.title,
            stats: stats.value,
            chosen: settings.statisticsDensityTypes,
            figures: figures.value,
            bgmEnd: bgmEnd.value,
        },
        strings.value,
        locale.value,
    ).join('\n')
const copy = async () => {
    copyFailed.value = false
    const container = body.value?.closest('dialog') ?? document.body
    if (await writeText(copyText(), container)) notify(() => i18n.value.statistics.copiedText)
    else copyFailed.value = true
}
const share = () => {
    void showModal(ShareImageModal, {
        stats: stats.value,
        every: every.value,
        bgmEnd: bgmEnd.value,
        drawable: drawable.value,
        chosen: settings.statisticsDensityTypes,
        mode: settings.statisticsChart,
        levelInfo: state.value.levelInfo,
        summary: copyText(),
    })
}
</script>

<template>
    <BaseModal :title="i18n.commands.statistics.title" fill @close="emit('close')">
        <div
            ref="body"
            v-scroll-edges.end
            class="stats-body relative flex min-h-0 flex-col gap-4 overflow-y-auto p-4"
            :class="{ 'no-cq': noContainerQueries, wide }"
            data-statistics
        >
            <dl class="stats-rows stats-one-col first outline-none" tabindex="-1" data-autofocus>
                <div class="stats-row stats-combo">
                    <dt>{{ strings.combo }}</dt>
                    <dd data-statistics-combo>{{ formatCount(stats.combo, locale) }}</dd>
                </div>
            </dl>

            <dl ref="list" class="stats-rows stats-two" data-statistics-list>
                <div
                    v-for="(item, i) in rows"
                    :key="item.row"
                    class="stats-row"
                    :class="{ 'col-top': i === 5, 'has-split': item.lines }"
                    :data-statistics-row="item.row"
                    @pointerenter="item.lines && breakdown.rowEnter(item.row, $event)"
                    @pointerleave="item.lines && breakdown.rowLeave(item.row, $event)"
                >
                    <dt>
                        <NoteShapeIcon :shape="shapes[item.row]" />
                        <span :id="`${idBase}-${item.row}`">{{ item.name }}</span>
                    </dt>
                    <dd>
                        <template v-if="item.lines">
                            <button
                                type="button"
                                class="stats-split"
                                :aria-expanded="breakdown.open.value?.key === item.row"
                                :aria-controls="bubbleId"
                                :aria-labelledby="`${idBase}-${item.row} ${idBase}-${item.row}-value`"
                                :aria-describedby="`${idBase}-${item.row}-split`"
                                data-statistics-split
                                @focus="breakdown.rowFocus(item.row, $event.target as Element)"
                                @blur="breakdown.rowBlur(item.row, $event)"
                                @click="breakdown.rowClick(item.row)"
                            >
                                <span :id="`${idBase}-${item.row}-value`">{{ item.value }}</span>
                            </button>
                            <span :id="`${idBase}-${item.row}-split`" hidden>{{
                                item.description
                            }}</span>
                        </template>
                        <template v-else>{{ item.value }}</template>
                    </dd>
                </div>
            </dl>

            <StatisticsChart
                v-if="stats.combo"
                :times="stats.times"
                :every
                :bgm-end
                :bpms="state.bpms"
                :figures
                :drawable
                :scroller="bodyElement"
            />

            <dl
                v-if="times.length"
                class="stats-rows stats-two"
                :style="{ '--rows': Math.ceil(times.length / 2) }"
                data-statistics-times
            >
                <div
                    v-for="(item, i) in times"
                    :key="item.label"
                    class="stats-row"
                    :class="{ 'col-top': i === Math.ceil(times.length / 2) }"
                >
                    <dt>{{ item.label }}</dt>
                    <dd>{{ item.value }}</dd>
                </div>
            </dl>

            <p class="flex items-start gap-2 text-sm empty:hidden" role="status">
                <template v-if="copyFailed">
                    <SeverityIcon severity="error" class="mt-0.5 size-4 shrink-0" />
                    <span data-statistics-copy-failed>{{ i18n.statistics.notCopiedText }}</span>
                </template>
            </p>

            <div class="flex flex-wrap justify-end gap-2">
                <button
                    type="button"
                    class="btn btn-secondary h-9 min-w-24 max-w-full truncate rounded-full px-4"
                    data-statistics-copy
                    @click="copy"
                >
                    {{ i18n.statistics.copyText }}
                </button>
                <button
                    type="button"
                    class="btn btn-secondary h-9 min-w-24 max-w-full truncate rounded-full px-4"
                    data-statistics-share
                    @click="share"
                >
                    {{ i18n.statistics.shareImage }}
                </button>
            </div>
        </div>
        <Teleport v-if="openRow" :to="body?.closest('dialog') ?? 'body'">
            <dl
                :id="bubbleId"
                ref="bubble"
                class="stats-bubble popup-surface fixed z-50"
                :class="{ invisible: !placement }"
                :style="{ left: `${placement?.left ?? 0}px`, top: `${placement?.top ?? 0}px` }"
                data-statistics-bubble
                @pointerenter="breakdown.bubbleEnter"
                @pointerleave="breakdown.bubbleLeave"
                @pointerdown="breakdown.bubbleDown"
            >
                <template v-for="line in openRow.lines" :key="line.label">
                    <dt>{{ line.label }}</dt>
                    <dd>{{ line.value }}</dd>
                </template>
            </dl>
        </Teleport>
    </BaseModal>
</template>

<style>
/* The Statistics dialog: Step Details' rows with a 14 px glyph column, in two columns of rows
   from a 32 rem content width, the chart full width. */
.stats-body {
    container-type: inline-size;
}
.stats-body.no-cq {
    container-type: normal;
}
.stats-body > * {
    flex-shrink: 0;
}

.stats-rows {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    column-gap: 2rem;
    @apply border-t border-fg/25;
}
.stats-rows.first {
    border-top: 0;
}
.stats-row {
    @apply relative flex items-center gap-2 border-t border-fg/15 py-1.5;
}
.stats-row:first-child {
    border-top-color: transparent;
}
.stats-row dt {
    @apply flex min-w-0 flex-1 items-center gap-2;
}
.stats-row dd {
    @apply whitespace-nowrap tabular-nums;
}
.stats-combo {
    @apply text-lg font-bold;
}
.stats-rows.blank dd {
    visibility: hidden;
}

@container (min-width: 32rem) {
    .stats-two {
        grid-template-columns: repeat(2, minmax(0, 1fr));
        grid-auto-flow: column;
        grid-template-rows: repeat(var(--rows, 5), auto);
    }
    .stats-two > .col-top {
        border-top-color: transparent;
    }
    .stats-one-col {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }
}
.stats-body.no-cq.wide .stats-two {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    grid-auto-flow: column;
    grid-template-rows: repeat(var(--rows, 5), auto);
}
.stats-body.no-cq.wide .stats-two > .col-top {
    border-top-color: transparent;
}
.stats-body.no-cq.wide .stats-one-col {
    grid-template-columns: repeat(2, minmax(0, 1fr));
}
.stats-rows[data-statistics-figures] {
    --rows: 2;
}

/* A row with a breakdown: its value is a button whose ::before covers the row. */
.stats-split {
    @apply cursor-pointer select-none tabular-nums outline-none;
    -webkit-tap-highlight-color: transparent;
    text-decoration: underline dotted rgb(var(--color-fg) / 0.6);
    text-decoration-thickness: 1px;
    text-underline-offset: 0.3em;
}
.stats-split::before {
    content: '';
    position: absolute;
    inset: 0 -0.5rem;
    border-radius: 0.5rem;
}
@media (hover: hover) and (pointer: fine) {
    .stats-split:hover::before {
        background: rgb(var(--color-fg) / 0.08);
    }
}
.stats-split[aria-expanded='true']::before {
    background: rgb(var(--color-fg) / 0.08);
}
.stats-split:active::before {
    background: rgb(var(--color-fg) / 0.15);
}
.stats-split:focus-visible::before {
    outline: 2px solid rgb(var(--color-fg));
    outline-offset: -2px;
}
.stats-bubble {
    display: grid;
    grid-template-columns: auto auto;
    column-gap: 1.5rem;
    row-gap: 0.25rem;
    min-width: 0;
    @apply px-3 py-2 text-sm;
}
.stats-bubble dd {
    @apply text-right tabular-nums;
}

/* Notes per Second. */
.stats-head {
    @apply -mb-1 flex flex-wrap items-center justify-between gap-2;
}
.stats-plot {
    position: relative;
}
.stats-label-line {
    position: sticky;
    top: -1rem;
    z-index: 2;
    height: calc(var(--lines, 1) * 1.25rem);
    padding: 0 0 0.5rem 2rem;
    box-sizing: content-box;
    background: linear-gradient(rgb(var(--color-modal)), rgb(var(--color-modal))) top / 100%
        calc(100% - 0.5rem) no-repeat;
    @apply text-sm;
}
.stats-label-line.stuck {
    /* Stuck over the plot, it is opaque to its edge. */
    background-size: 100% 100%;
    box-shadow: var(--shadow-band);
}
.stats-readout {
    position: absolute;
    left: 2rem;
    right: 0;
    bottom: 0.5rem;
    display: flex;
    flex-wrap: wrap-reverse;
    column-gap: 0.625rem;
    @apply whitespace-nowrap tabular-nums;
}
.stats-probe {
    top: 0;
    bottom: auto;
    flex-wrap: wrap;
    visibility: hidden;
}
.stats-facts {
    display: inline-flex;
    flex-wrap: wrap;
    column-gap: 0.625rem;
    max-width: 100%;
}
.stats-total {
    min-width: var(--v, 3ch);
}
.stats-bgm-label {
    position: absolute;
    bottom: 0;
    transform: translateX(-100%);
    padding-right: 0.25rem;
    @apply whitespace-nowrap text-xs;
}
.stats-plot-row {
    display: flex;
    flex-direction: column;
}
.stats-plot-row.side {
    flex-direction: row;
    align-items: flex-start;
    gap: 0.75rem;
}
.stats-chart {
    position: relative;
    height: 10rem;
    margin: 0 0 1.25rem 2rem;
    touch-action: pan-y;
    outline: none;
    width: calc(100% - 2rem);
    align-self: flex-end;
}
.stats-plot-row.side .stats-chart {
    flex: 1;
    min-width: 0;
    width: auto;
    align-self: auto;
}
@container (max-width: 31.99rem) {
    .stats-chart {
        height: 8.5rem;
    }
}
.stats-body.no-cq:not(.wide) .stats-chart {
    height: 8.5rem;
}
@media (max-height: 30rem) {
    .stats-chart {
        height: 8.5rem;
    }
}
.stats-chart svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
}
.stats-grid {
    stroke: rgb(var(--color-fg) / 0.15);
}
.stats-wash-top {
    stop-color: rgb(var(--color-fg));
    stop-opacity: 0.22;
}
.stats-wash-bottom {
    stop-color: rgb(var(--color-fg));
    stop-opacity: 0.03;
}
.stats-line {
    fill: none;
    stroke: rgb(var(--color-fg));
    stroke-width: 1;
    stroke-linejoin: round;
    stroke-linecap: round;
}
.stats-fc-only {
    display: none;
}
.stats-marker {
    stroke: rgb(var(--color-fg) / 0.8);
}
.stats-tick {
    position: absolute;
    @apply whitespace-nowrap text-xs tabular-nums text-fg/80;
}
.stats-tick-y {
    right: calc(100% + 0.375rem);
    transform: translateY(-50%);
}
.stats-tick-x {
    top: calc(100% + 0.25rem);
    transform: translateX(-50%);
}
.stats-tick-x.end {
    transform: translateX(-100%);
}
.stats-tick-x:not(.narrow) {
    display: none;
}
@container (min-width: 32rem) {
    .stats-tick-x:not(.narrow) {
        display: inline;
    }
    .stats-tick-x:not(.wide) {
        display: none;
    }
}
.stats-body.no-cq.wide .stats-tick-x:not(.narrow) {
    display: inline;
}
.stats-body.no-cq.wide .stats-tick-x:not(.wide) {
    display: none;
}
.stats-dot {
    position: absolute;
    width: 0.625rem;
    height: 0.625rem;
    margin: -0.3125rem 0 0 -0.3125rem;
    border-radius: 9999px;
    background: rgb(var(--color-fg));
    box-shadow: 0 0 0 2px rgb(var(--color-modal));
    pointer-events: none;
}
.stats-cross {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    background: rgb(var(--color-fg) / 0.8);
    pointer-events: none;
}
.stats-plot-focus {
    position: absolute;
    inset: calc(-1rem - var(--lines, 1) * 1.25rem) -0.375rem -1.75rem -2.25rem;
    border-radius: 0.75rem;
    outline: 2px solid rgb(var(--color-fg));
    pointer-events: none;
}
.stats-empty {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    @apply text-fg/80;
}

/* The legend: the control. A column of 24 px rows beside the plot from a 1024 px viewport,
   bottom-aligned with the baseline; else a grid of 36 px rows below it. */
.stats-key {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(9.5rem, 1fr));
    column-gap: 0.25rem;
    margin-top: 0.25rem;
    @apply text-sm;
}
.stats-plot-row.side .stats-key {
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    flex-shrink: 0;
    height: 10rem;
    margin-top: 0;
}
.stats-entry {
    position: relative;
    display: block;
    border-radius: 0.5rem;
    cursor: pointer;
}
.stats-entry input {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
}
.stats-entry-face {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    height: 2.25rem;
    padding: 0 0.5rem;
    border-radius: 0.5rem;
    white-space: nowrap;
}
.stats-plot-row.side .stats-entry-face {
    height: 1.5rem;
}
.stats-entry-name {
    flex: 1;
}
.stats-entry:not(.on) .stats-entry-name {
    @apply text-fg/80;
}
.stats-entry-value {
    min-width: var(--v, 3ch);
    @apply font-bold tabular-nums;
}
.stats-plot-row.side .stats-entry-value {
    text-align: right;
}
@media (hover: hover) and (pointer: fine) {
    .stats-entry:hover .stats-entry-face {
        background: rgb(var(--color-fg) / 0.08);
    }
}
.stats-entry:active .stats-entry-face {
    background: rgb(var(--color-fg) / 0.15);
}
.stats-entry input:focus-visible + .stats-entry-face {
    outline: 2px solid rgb(var(--color-fg));
    outline-offset: -2px;
}
/* The mark: the layer's swatch, filled when on with a 1 px edge, a 2 px ring when off; ink in
   Rolling. */
.stats-mark {
    width: 0.75rem;
    height: 0.75rem;
    flex-shrink: 0;
    border-radius: 0.1875rem;
    box-shadow: inset 0 0 0 2px var(--c);
}
.stats-entry.on .stats-mark {
    background: var(--c);
    box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.3);
}
.stats-mark.ink {
    --c: rgb(var(--color-fg) / 0.8);
}
.stats-entry.on .stats-mark.ink {
    background: rgb(var(--color-fg));
    box-shadow: none;
}

@media (forced-colors: active) {
    .stats-line,
    .stats-marker {
        stroke: CanvasText;
    }
    .stats-grid {
        stroke: GrayText;
    }
    .stats-layer {
        display: none;
    }
    .stats-fc-only {
        display: inline;
    }
    .stats-mark {
        forced-color-adjust: none;
        box-shadow: inset 0 0 0 2px CanvasText;
    }
    .stats-entry.on .stats-mark,
    .stats-entry.on .stats-mark.ink {
        background: CanvasText;
    }
    .stats-split:focus-visible::before {
        outline-color: CanvasText;
    }
    .stats-bubble {
        outline: 1px solid CanvasText;
    }
    .stats-dot,
    .stats-cross {
        background: CanvasText;
        forced-color-adjust: none;
    }
}
</style>
