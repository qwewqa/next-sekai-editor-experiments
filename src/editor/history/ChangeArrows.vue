<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue'
import { isPeeking } from '../../history/peek'
import { i18n } from '../../i18n'
import { interpolateRaw } from '../../utils/interpolate'
import { peekClearance, sheetBox } from '../toolModals'
import { view } from '../view'
import ChevronIcon from '../workspace/ChevronIcon.vue'
import {
    changeBand,
    changeLine,
    comparisonStatus,
    countsShown,
    offBand,
    showChangeToward,
} from './changes'

const root = useTemplateRef<HTMLElement>('root')
const measure = () => {
    const bar = root.value?.parentElement
    const pane = bar?.parentElement
    if (!pane || !bar) return
    const box = pane.getBoundingClientRect()
    const top = Math.max(0, bar.getBoundingClientRect().bottom - box.top)
    let bottom = 0
    const tools = pane
        .querySelector(':scope > [data-editor-toolbar]')
        ?.firstElementChild?.getBoundingClientRect()
    if (tools && tools.height > 0) bottom = Math.max(0, box.bottom - tools.top)
    if (sheetBox.value?.side === 'bottom') bottom = Math.max(bottom, sheetBox.value.size + 8)
    peekClearance.value = top
    changeBand.value = { top, bottom }
}
let observer: ResizeObserver | undefined
onMounted(() => {
    observer = new ResizeObserver(measure)
    const bar = root.value?.parentElement
    if (bar) observer.observe(bar)
    if (bar?.parentElement) observer.observe(bar.parentElement)
    const toolbar = bar?.parentElement?.querySelector(':scope > [data-editor-toolbar]')
    if (toolbar) observer.observe(toolbar)
    measure()
})
onBeforeUnmount(() => {
    observer?.disconnect()
    peekClearance.value = 0
})
watch([sheetBox, () => view.h, () => view.w], () => void nextTick(measure))
const delayed = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined
watch(
    comparisonStatus,
    (status) => {
        clearTimeout(timer)
        delayed.value = false
        if (status === 'loading')
            timer = setTimeout(() => {
                delayed.value = true
            }, 250)
    },
    { immediate: true, flush: 'sync' },
)
onBeforeUnmount(() => clearTimeout(timer))
const line = computed(
    () => changeLine.value ?? (delayed.value ? i18n.value.peek.loadingChanges : ''),
)
const directions = ['up', 'down'] as const
const countOf = (direction: 'up' | 'down') =>
    direction === 'up' ? offBand.value.above : offBand.value.below
const labelOf = (direction: 'up' | 'down') => {
    const strings = i18n.value.peek
    return countsShown.value
        ? interpolateRaw(
              direction === 'up' ? strings.changesAbove : strings.changesBelow,
              String(countOf(direction)),
          )
        : direction === 'up'
          ? strings.changesAboveAny
          : strings.changesBelowAny
}
</script>

<template>
    <div
        v-if="isPeeking"
        ref="root"
        class="pointer-events-auto flex h-[52px] w-full max-w-lg items-center gap-1 rounded-3xl bg-modal p-1 pl-4 text-sm text-fg shadow-md"
        data-peek-navigation
    >
        <span
            class="min-w-0 flex-1 truncate"
            :title="line"
            :aria-label="line"
            aria-live="polite"
            data-peek-change
            >{{ line }}</span
        >
        <button
            v-for="direction in directions"
            :key="direction"
            type="button"
            class="change-arrow flex h-11 w-16 shrink-0 items-center justify-center gap-1 rounded-full bg-button text-xs tabular-nums outline-offset-[-3px] focus-visible:outline focus-visible:outline-2"
            :aria-disabled="!countOf(direction)"
            :aria-label="labelOf(direction)"
            :title="labelOf(direction)"
            :data-change-arrow="direction"
            :data-count="countsShown ? countOf(direction) : undefined"
            @click="countOf(direction) && showChangeToward(direction)"
        >
            <ChevronIcon :direction="direction" /><span class="w-6 text-center">{{
                countsShown && countOf(direction) ? countOf(direction) : ''
            }}</span>
        </button>
    </div>
</template>

<style scoped>
.change-arrow[aria-disabled='true'] {
    opacity: 0.45;
}
@media (forced-colors: active) {
    .change-arrow {
        border: 1px solid ButtonText;
    }
    .change-arrow[aria-disabled='true'] {
        color: GrayText;
        border-color: GrayText;
        opacity: 1;
    }
}
</style>
