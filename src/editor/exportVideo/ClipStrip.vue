<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, useTemplateRef, watch } from 'vue'
import { i18n } from '../../i18n'
import { chartModel, chartStatistics, mergeTimes } from '../../levelData/statistics'
import { createFontContext } from '../../rendering/textRaster'
import type { RangeKind } from './clipRange'
import { formatClipTime, rulerLabel, rulerStep } from './clipTime'
import type { ExportDialog } from './dialog'

// The overview strip: the ruler, the notes-per-second curve, the range with its handles, and the
// playhead. The playhead, In and Out are sliders, in that tab order.
const props = defineProps<{
    dialog: ExportDialog
    /** 48 px on phones and in phone landscape, else 56. */
    compact: boolean
    /** Below a 360 px body in phone landscape: the knob moves into the track. */
    hideRuler: boolean
}>()
const emit = defineEmits<{
    /** A drag or seek began: playback pauses and plays no sound. */
    scrub: []
}>()

const d = props.dialog
const root = useTemplateRef<HTMLDivElement>('root')
const width = ref(0)
const trackHeight = computed(() => (props.compact ? 48 : 56))
const rulerHeight = computed(() => (props.hideRuler ? 0 : 16))

// --- The mapping, recomputed when Zoom to Range is pressed and when a drag ends, never during one.
type Drag = {
    kind: 'in' | 'out' | 'playhead'
    pointer: number
    /** As the drag began: a shorter clip on the way may have trimmed the fades. */
    from: {
        in: number
        out: number
        playhead: number
        kind: RangeKind
        fadeIn: number
        fadeOut: number
    }
}
const drag = shallowRef<Drag>()
const span = ref<[number, number]>(d.stripSpan.value)
const remap = () => {
    span.value = d.stripSpan.value
}
watch(d.stripSpan, () => {
    if (!drag.value) remap()
})
const x = (time: number) => ((time - span.value[0]) / (span.value[1] - span.value[0])) * width.value
const timeAt = (px: number) =>
    span.value[0] +
    (Math.min(width.value, Math.max(0, px)) / Math.max(1, width.value)) *
        (span.value[1] - span.value[0])

// --- The curve: notes per second, from the whole chart once.
const every = mergeTimes(Object.values(chartStatistics(d.input.snapshot).times)).times
const curvePath = computed(() => {
    const w = width.value
    const h = trackHeight.value
    if (!w || !every.length) return undefined
    const [a, b] = span.value
    const columns = Math.min(20000, Math.max(2, Math.round((2 * w * d.stripEnd) / (b - a))))
    const model = chartModel('smooth', every, [every], d.bgmEnd, columns)
    const total = model?.boundaries.at(-1)
    if (!model || !total) return undefined
    let max = 0
    for (const value of total) max = Math.max(max, value)
    if (!(max > 0)) return undefined
    const points: string[] = []
    for (let i = 0; i < model.xs.length; i++) {
        const px = x(model.xs[i] ?? 0)
        const py = h - ((total[i] ?? 0) / max) * (h - 6)
        points.push(`${points.length ? 'L' : 'M'}${px.toFixed(1)} ${py.toFixed(1)}`)
    }
    const line = points.join('')
    const first = x(model.xs[0] ?? 0)
    const last = x(model.xs.at(-1) ?? 0)
    return { line, area: `${line}L${last.toFixed(1)} ${h}L${first.toFixed(1)} ${h}Z` }
})

// --- The ruler: labels at least 64 px apart; one under the knob or a handle face is hidden.
let font: CanvasRenderingContext2D | null | undefined
const labelWidth = (text: string) => {
    font ??= createFontContext()
    if (!font || !root.value) return text.length * 7
    font.font = `12px ${getComputedStyle(root.value).fontFamily}`
    return font.measureText(text).width
}
const ruler = computed(() => {
    const w = width.value
    if (!w || props.hideRuler) return []
    const [a, b] = span.value
    const step = rulerStep(w / (b - a))
    const covers = [
        [x(d.playhead.value) - 6, x(d.playhead.value) + 6],
        [x(d.range.value.in) - 7, x(d.range.value.in) + 7],
        [x(d.range.value.out) - 7, x(d.range.value.out) + 7],
    ]
    const labels: { time: number; text: string; left: number; flush: boolean; hidden: boolean }[] =
        []
    for (let time = Math.ceil(a / step - 1e-9) * step; time <= b; time += step) {
        const text = rulerLabel(time)
        const px = x(time)
        const half = labelWidth(text) / 2
        const flush = px < half
        const from = flush ? px : px - half
        const to = flush ? px + 2 * half : px + half
        if (to > w) break
        labels.push({
            time,
            text,
            left: px,
            flush,
            hidden: covers.some(([c0 = 0, c1 = 0]) => to > c0 && from < c1),
        })
    }
    return labels
})

const xIn = computed(() => x(d.range.value.in))
const xOut = computed(() => x(d.range.value.out))
const xPlayhead = computed(() => x(d.playhead.value))
const xBgm = computed(() => (d.bgmEnd === undefined ? undefined : x(d.bgmEnd)))
const exporting = computed(() => ['exporting', 'cancelling', 'finishing'].includes(d.phase.value))

// --- Pointer input: a press on a handle drags it; anywhere else on the ruler or track seeks.
const HIT = 22
const target = (px: number, py: number): Drag['kind'] => {
    // Handles reach 4 px above the track; the ruler above them seeks.
    if (py < rulerHeight.value - 4) return 'playhead'
    const dIn = Math.abs(px - xIn.value)
    const dOut = Math.abs(px - xOut.value)
    if (dIn <= HIT && dOut <= HIT) return px < (xIn.value + xOut.value) / 2 ? 'in' : 'out'
    if (dIn <= HIT) return 'in'
    if (dOut <= HIT) return 'out'
    return 'playhead'
}
const moveTo = (kind: Drag['kind'], time: number) => {
    // A drag keeps the span it began with; a key uses the span after the change.
    const within = drag.value ? span.value : undefined
    if (kind === 'playhead') d.seek(time, within)
    else {
        d.setClipEnd(kind, time)
        // The frame view shows the end being moved.
        d.seek(d.range.value[kind], within)
    }
}
const onPointerDown = (event: PointerEvent) => {
    if (d.busy.value || drag.value || !event.isPrimary || event.button !== 0) return
    const box = root.value?.getBoundingClientRect()
    if (!box) return
    const px = event.clientX - box.left
    const kind = target(px, event.clientY - box.top)
    drag.value = {
        kind,
        pointer: event.pointerId,
        from: {
            ...d.range.value,
            playhead: d.playhead.value,
            kind: d.rangeKind.value,
            fadeIn: d.form.fadeIn,
            fadeOut: d.form.fadeOut,
        },
    }
    root.value?.setPointerCapture(event.pointerId)
    emit('scrub')
    // A handle is grabbed where it is; the playhead jumps to the press.
    if (kind === 'playhead') moveTo(kind, timeAt(px))
    else d.movePlayhead(d.range.value[kind])
    window.addEventListener('keydown', onDragKey, true)
    event.preventDefault()
}
const onPointerMove = (event: PointerEvent) => {
    const current = drag.value
    if (!current) return
    if (event.pointerId !== current.pointer) return
    const box = root.value?.getBoundingClientRect()
    if (!box) return
    moveTo(current.kind, timeAt(event.clientX - box.left))
}
const endDrag = () => {
    drag.value = undefined
    window.removeEventListener('keydown', onDragKey, true)
    remap()
}
const onPointerUp = (event: PointerEvent) => {
    if (drag.value?.pointer === event.pointerId) endDrag()
}
// Escape puts the handle or the playhead back where the drag began.
const onDragKey = (event: KeyboardEvent) => {
    const current = drag.value
    if (event.key !== 'Escape' || !current) return
    event.preventDefault()
    event.stopPropagation()
    if (current.kind !== 'playhead') {
        d.setRange({ in: current.from.in, out: current.from.out }, current.from.kind)
        d.form.fadeIn = current.from.fadeIn
        d.form.fadeOut = current.from.fadeOut
    }
    d.movePlayhead(current.from.playhead)
    if (root.value?.hasPointerCapture(current.pointer))
        root.value.releasePointerCapture(current.pointer)
    endDrag()
}

// --- Keys on a focused slider.
const step = (kind: Drag['kind'], event: KeyboardEvent) => {
    const fps = d.fps()
    const now = kind === 'playhead' ? d.playhead.value : d.range.value[kind]
    let next: number | undefined
    switch (event.key) {
        case 'ArrowLeft':
        case 'ArrowDown':
            next = now - (event.shiftKey ? 1 : 1 / fps)
            break
        case 'ArrowRight':
        case 'ArrowUp':
            next = now + (event.shiftKey ? 1 : 1 / fps)
            break
        case 'PageDown':
            next = now - 5
            break
        case 'PageUp':
            next = now + 5
            break
        case 'Home':
            next = kind === 'playhead' ? d.range.value.in : 0
            break
        case 'End':
            next = kind === 'playhead' ? d.range.value.out : d.stripEnd
            break
    }
    if (next === undefined) return
    event.preventDefault()
    event.stopPropagation()
    if (d.busy.value) return
    emit('scrub')
    moveTo(kind, Math.max(0, next))
    if (kind !== 'playhead') remap()
}

const sliderText = (time: number) => formatClipTime(time, d.hours)

let observer: ResizeObserver | undefined
onMounted(() => {
    observer = new ResizeObserver(() => {
        width.value = root.value?.clientWidth ?? 0
    })
    if (root.value) observer.observe(root.value)
    width.value = root.value?.clientWidth ?? 0
})
onBeforeUnmount(() => {
    observer?.disconnect()
    window.removeEventListener('keydown', onDragKey, true)
})
</script>

<template>
    <div
        ref="root"
        class="clip-strip relative min-w-0 flex-1 select-none"
        :class="drag ? 'cursor-ew-resize' : 'cursor-pointer'"
        :style="{ height: `${rulerHeight + trackHeight}px` }"
        data-clip-strip
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @lostpointercapture="onPointerUp"
    >
        <div
            v-if="!hideRuler"
            class="relative h-4 text-xs text-fg/80 tabular-nums"
            aria-hidden="true"
            data-clip-ruler
        >
            <span
                v-for="label in ruler"
                :key="label.time"
                class="absolute top-0 leading-4 whitespace-nowrap"
                :class="{ '-translate-x-1/2': !label.flush, invisible: label.hidden }"
                :style="{ left: `${label.left}px` }"
                >{{ label.text }}</span
            >
        </div>
        <div
            class="absolute inset-x-0 bottom-0 overflow-hidden rounded-lg bg-recess shadow-track"
            :style="{ height: `${trackHeight}px` }"
            data-clip-track
        >
            <svg
                v-if="curvePath"
                class="absolute inset-0"
                :width
                :height="trackHeight"
                aria-hidden="true"
            >
                <path :d="curvePath.area" class="fill-fg/30" />
                <path :d="curvePath.line" fill="none" class="stroke-fg/60" stroke-width="1" />
            </svg>
            <div
                v-if="xBgm !== undefined && xBgm >= 0 && xBgm < width"
                class="absolute inset-y-0 w-px bg-fg/60"
                :style="{ left: `${Math.round(xBgm)}px` }"
            />
            <div
                class="absolute inset-y-0 left-0 bg-scrim/50"
                :style="{ width: `${Math.max(0, xIn)}px` }"
            />
            <div
                class="absolute inset-y-0 right-0 bg-scrim/50"
                :style="{ left: `${Math.min(width, xOut)}px` }"
            />
            <div
                class="absolute inset-y-0 border-y-2 border-accent-strong"
                :style="{ left: `${xIn}px`, width: `${Math.max(0, xOut - xIn)}px` }"
            />
            <div
                v-if="exporting"
                class="absolute bottom-0.5 h-1 bg-fg"
                :style="{ left: `${xIn}px`, width: `${Math.max(0, xPlayhead - xIn)}px` }"
                data-clip-progress
            />
        </div>
        <!-- The playhead: a line from the knob through the track. -->
        <div
            class="pointer-events-none absolute bottom-0 z-2 w-0.5 bg-fg-strong"
            :style="{ left: `${xPlayhead - 1}px`, top: hideRuler ? '0px' : '8px' }"
        />
        <div
            class="clip-knob focus-ring focus-out absolute z-2 size-2 rounded-full bg-fg-strong ring-2"
            :class="hideRuler ? 'ring-button' : 'ring-modal'"
            :style="{ left: `${xPlayhead - 4}px`, top: '4px' }"
            role="slider"
            :tabindex="0"
            :aria-label="i18n.exportVideo.playhead"
            :aria-valuemin="Math.round(span[0] * 1000) / 1000"
            :aria-valuemax="Math.round(span[1] * 1000) / 1000"
            :aria-valuenow="Math.round(d.playhead.value * 1000) / 1000"
            :aria-valuetext="sliderText(d.playhead.value)"
            :aria-disabled="d.busy.value || undefined"
            data-clip-playhead
            @keydown="step('playhead', $event)"
        />
        <div
            v-for="end in ['in', 'out'] as const"
            :key="end"
            class="clip-handle btn focus-ring focus-out btn-secondary absolute z-3 flex w-2.5 items-center justify-center rounded-full ring-1 ring-fg/80 ring-inset"
            :class="{
                'opacity-40': d.busy.value,
                'is-pressed': drag?.kind === end,
            }"
            :style="{
                left: `${(end === 'in' ? xIn : xOut) - 5}px`,
                top: `${rulerHeight - 4}px`,
                height: `${trackHeight + 8}px`,
            }"
            role="slider"
            tabindex="0"
            :aria-label="end === 'in' ? i18n.exportVideo.in : i18n.exportVideo.out"
            :aria-valuemin="0"
            :aria-valuemax="Math.round(d.stripEnd * 1000) / 1000"
            :aria-valuenow="Math.round(d.range.value[end] * 1000) / 1000"
            :aria-valuetext="sliderText(d.range.value[end])"
            :aria-disabled="d.busy.value || undefined"
            :data-clip-handle="end"
            @keydown="step(end, $event)"
        >
            <span class="h-4 w-0.5 rounded-full bg-fg/70" aria-hidden="true" />
        </div>
    </div>
</template>

<style scoped>
.clip-strip {
    touch-action: pan-y;
}

/* 44 px targets: the handle's full height, 17 px past its face each side; the knob's square. */
.clip-handle::before {
    content: '';
    position: absolute;
    inset: 0 -17px;
}

.clip-knob::before {
    content: '';
    position: absolute;
    inset: -18px;
}

.clip-handle {
    cursor: ew-resize;
    padding: 0;
    min-width: 0;
}
</style>
