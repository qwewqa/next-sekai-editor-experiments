<script setup lang="ts">
import { onMounted, onUnmounted, ref, useTemplateRef } from 'vue'
import { i18n } from '../i18n'
import { interpolateRaw } from '../utils/interpolate'
import ChevronIcon from './workspace/ChevronIcon.vue'
import type { OffscreenNoteGroup } from './offscreenNotes'

const props = defineProps<{
    indicator: OffscreenNoteGroup
    hovered: boolean
}>()

const root = useTemplateRef<HTMLElement>('root')
// A top or bottom badge's half width in device pixels, so it centres on whole pixels.
const half = ref<number>()
const measure = () => {
    if (props.indicator.x === undefined || !root.value) return
    const ratio = devicePixelRatio || 1
    half.value = Math.round((root.value.getBoundingClientRect().width / 2) * ratio) / ratio
}
let observer: ResizeObserver | undefined
onMounted(() => {
    if (props.indicator.x === undefined || !root.value) return
    observer = new ResizeObserver(measure)
    observer.observe(root.value)
})
onUnmounted(() => observer?.disconnect())
</script>

<template>
    <div
        ref="root"
        class="offscreen-note-indicator absolute flex h-6 -translate-y-1/2 items-center gap-0.5 rounded-full border bg-preview px-1 text-xs tabular-nums text-white shadow-sm"
        :class="[
            indicator.side === 'left'
                ? 'left-1'
                : indicator.side === 'right'
                  ? 'right-1 flex-row-reverse'
                  : half === undefined && '-translate-x-1/2',
            indicator.highlighted ? 'border-white' : 'border-white/25',
            hovered && 'is-hovered ring-2 ring-accent',
        ]"
        :style="{
            top: `${indicator.y}px`,
            left:
                indicator.x === undefined
                    ? undefined
                    : `${half === undefined ? indicator.x : indicator.x - half}px`,
            opacity: indicator.opacity,
        }"
        :data-side="indicator.side"
        :data-slot="indicator.slot"
        :data-count="indicator.count"
        :data-selectable="indicator.targets.length"
        role="img"
        :aria-label="interpolateRaw(i18n.offscreenNotes[indicator.side], String(indicator.count))"
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
        <span>{{ indicator.count }}</span>
    </div>
</template>
