<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, useTemplateRef, watch } from 'vue'
import { isPeeking } from '../../history/peek'
import { i18n } from '../../i18n'
import { interpolateRaw } from '../../utils/interpolate'
import { sheetBox } from '../toolModals'
import { view } from '../view'
import { isCoarsePointer } from '../workspace'
import ChevronIcon from '../workspace/ChevronIcon.vue'
import {
    arrowGap,
    arrowsShown,
    changeBand,
    countsShown,
    offBand,
    showChangeToward,
} from './changes'
import { peekedInfo } from './selection'

// The edge arrows (Part 1 §1.4.11): while a peeked entry's change lies off screen, a badge at the
// chart's top or bottom edge counts it, in the off-screen note badges' look, and brings the next
// part of it into view when pressed. They also measure the band clear of the peek bar above and
// the toolbar or the History sheet below, which the counts, Show Change and Edits Here use.

const root = useTemplateRef<HTMLElement>('root')

const measure = () => {
    const pane = root.value?.parentElement
    if (!pane) return
    const box = pane.getBoundingClientRect()
    const bar = pane.querySelector(':scope > [data-peek-bar]')
    const top = bar ? Math.max(0, bar.getBoundingClientRect().bottom - box.top) : 0
    let bottom = 0
    const toolbar = pane.querySelector(':scope > [data-editor-toolbar]')?.firstElementChild
    const tools = toolbar?.getBoundingClientRect()
    if (tools && tools.height > 0) bottom = Math.max(0, box.bottom - tools.top)
    const sheet = sheetBox.value
    if (sheet?.side === 'bottom') bottom = Math.max(bottom, sheet.size)
    const next = { top, bottom }
    if (next.top !== changeBand.value.top || next.bottom !== changeBand.value.bottom)
        changeBand.value = next
}

let observer: ResizeObserver | undefined
const observed = new Set<Element>()
const observe = () => {
    const pane = root.value?.parentElement
    if (!pane || !observer) return
    const targets = [
        pane,
        pane.querySelector(':scope > [data-peek-bar]'),
        pane.querySelector(':scope > [data-editor-toolbar]')?.firstElementChild,
    ].filter((element): element is Element => !!element)
    for (const element of observed)
        if (!targets.includes(element)) {
            observer.unobserve(element)
            observed.delete(element)
        }
    for (const element of targets)
        if (!observed.has(element)) {
            observer.observe(element)
            observed.add(element)
        }
    measure()
}
onMounted(() => {
    observer = new ResizeObserver(measure)
    observe()
})
onBeforeUnmount(() => observer?.disconnect())
watch([isPeeking, peekedInfo, sheetBox, () => view.h, () => view.w], () => void nextTick(observe))

const labelOf = (direction: 'up' | 'down') => {
    const strings = i18n.value.peek
    const count = direction === 'up' ? offBand.value.above : offBand.value.below
    if (!countsShown.value)
        return direction === 'up' ? strings.changesAboveAny : strings.changesBelowAny
    return interpolateRaw(
        direction === 'up' ? strings.changesAbove : strings.changesBelow,
        String(count),
    )
}

const arrows = computed(() => {
    if (!arrowsShown.value) return []
    const list: { direction: 'up' | 'down'; count: number }[] = []
    if (offBand.value.above) list.push({ direction: 'up', count: offBand.value.above })
    if (offBand.value.below) list.push({ direction: 'down', count: offBand.value.below })
    return list
})
</script>

<template>
    <div ref="root" class="contents">
        <button
            v-for="{ direction, count } in arrows"
            :key="direction"
            type="button"
            class="change-arrow group absolute left-1/2 z-20 flex -translate-x-1/2 items-center justify-center outline-none"
            :class="isCoarsePointer ? 'min-h-11 min-w-11' : ''"
            :style="
                direction === 'up'
                    ? { top: `${changeBand.top + arrowGap}px` }
                    : { bottom: `${changeBand.bottom + arrowGap}px` }
            "
            :aria-label="labelOf(direction)"
            :title="labelOf(direction)"
            :data-change-arrow="direction"
            :data-count="countsShown ? count : undefined"
            @click="showChangeToward(direction)"
        >
            <span
                class="flex h-6 items-center gap-1 rounded-full border border-white/25 bg-preview px-1.5 text-xs tabular-nums text-white shadow-sm transition-colors group-hover:border-white group-focus-visible:ring-2 group-focus-visible:ring-accent group-active:bg-accent group-active:text-on-accent"
            >
                <ChevronIcon :direction="direction" />
                <span
                    class="size-2 shrink-0 rounded-full bg-change forced-colors:bg-[Highlight]"
                    aria-hidden="true"
                />
                <span v-if="countsShown">{{ count }}</span>
            </span>
        </button>
    </div>
</template>
