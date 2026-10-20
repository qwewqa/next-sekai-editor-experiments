<script setup lang="ts">
import { onMounted, onUnmounted, ref, useTemplateRef } from 'vue'
import { i18n } from '../i18n'
import { interpolateRaw } from '../utils/interpolate'
import { formatCount } from '../utils/size'
import ChevronIcon from './workspace/ChevronIcon.vue'
import type { OffscreenNoteGroup } from './offscreenNotes'

const props = defineProps<{
    indicator: OffscreenNoteGroup
    hovered: boolean
}>()

const root = useTemplateRef<HTMLElement>('root')
// A top or bottom badge's size, so its corner lands on device pixels.
const size = ref<{ width: number; height: number }>()
const measure = () => {
    if (!root.value) return
    const { width, height } = root.value.getBoundingClientRect()
    size.value = { width, height }
}
const ratio = ref(devicePixelRatio || 1)
let ratioQuery: MediaQueryList | undefined
const updateRatio = () => {
    ratio.value = devicePixelRatio || 1
    ratioQuery?.removeEventListener('change', updateRatio)
    ratioQuery = matchMedia(`(resolution: ${ratio.value}dppx)`)
    ratioQuery.addEventListener('change', updateRatio)
}
const pixel = (value: number) => Math.round(value * ratio.value) / ratio.value
let observer: ResizeObserver | undefined
onMounted(() => {
    if (props.indicator.x === undefined || !root.value) return
    observer = new ResizeObserver(measure)
    observer.observe(root.value)
    updateRatio()
})
onUnmounted(() => {
    observer?.disconnect()
    ratioQuery?.removeEventListener('change', updateRatio)
})
</script>

<template>
    <div
        ref="root"
        class="offscreen-note-indicator absolute flex h-6 items-center gap-0.5 rounded-full border bg-preview px-1 text-xs tabular-nums text-white shadow-sm"
        :class="[
            indicator.side === 'left'
                ? 'left-1'
                : indicator.side === 'right'
                  ? 'right-1 flex-row-reverse'
                  : size === undefined && '-translate-x-1/2',
            size === undefined && '-translate-y-1/2',
            indicator.highlighted ? 'border-white' : 'border-white/25',
            hovered && 'is-hovered ring-2 ring-white/60',
        ]"
        :style="{
            top: `${size === undefined ? indicator.y : pixel(indicator.y - size.height / 2)}px`,
            left:
                indicator.x === undefined
                    ? undefined
                    : `${size === undefined ? indicator.x : pixel(indicator.x - size.width / 2)}px`,
            opacity: indicator.opacity,
        }"
        :data-side="indicator.side"
        :data-slot="indicator.slot"
        :data-count="indicator.count"
        :data-selectable="indicator.targets.length"
        role="img"
        :aria-label="
            interpolateRaw(i18n.offscreenNotes[indicator.side], formatCount(indicator.count))
        "
    >
        <ChevronIcon
            :direction="
                indicator.side === 'top'
                    ? 'up'
                    : indicator.side === 'bottom'
                      ? 'down'
                      : indicator.side
            "
        />
        <span>{{ formatCount(indicator.count) }}</span>
    </div>
</template>
