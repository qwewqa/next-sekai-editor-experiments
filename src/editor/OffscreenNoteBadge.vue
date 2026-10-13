<script setup lang="ts">
import { i18n } from '../i18n'
import { interpolateRaw } from '../utils/interpolate'
import ChevronIcon from './workspace/ChevronIcon.vue'
import type { OffscreenNoteGroup } from './offscreenNotes'

defineProps<{
    indicator: OffscreenNoteGroup
    hovered: boolean
}>()
</script>

<template>
    <div
        class="offscreen-note-indicator absolute flex h-6 -translate-y-1/2 items-center gap-0.5 rounded-full border bg-preview px-1 text-xs tabular-nums text-white shadow-sm"
        :class="[
            indicator.side === 'left'
                ? 'left-1'
                : indicator.side === 'right'
                  ? 'right-1 flex-row-reverse'
                  : '-translate-x-1/2',
            indicator.highlighted ? 'border-white' : 'border-white/25',
            hovered && 'is-hovered ring-2 ring-accent',
        ]"
        :style="{
            top: `${indicator.y}px`,
            left: indicator.x === undefined ? undefined : `${indicator.x}px`,
            opacity: indicator.opacity,
        }"
        :data-side="indicator.side"
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
