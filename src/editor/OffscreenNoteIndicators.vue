<script setup lang="ts">
import { i18n } from '../i18n'
import { interpolateRaw } from '../utils/interpolate'
import ChevronIcon from './workspace/ChevronIcon.vue'
import type { OffscreenNoteGroup } from './offscreenNotes'

defineProps<{
    groups: OffscreenNoteGroup[]
    hovered?: OffscreenNoteGroup
    // Pane y the badges are placed from.
    anchor: number
}>()
</script>

<template>
    <div class="pointer-events-none absolute inset-0 overflow-hidden">
        <!-- Scrolling moves only this layer; the badges re-render when they change. -->
        <div class="absolute inset-x-0 top-0" :style="{ transform: `translateY(${anchor}px)` }">
            <div v-memo="[groups, hovered, i18n.offscreenNotes]">
                <div
                    v-for="indicator in groups"
                    :key="`${indicator.side}:${indicator.slot}`"
                    class="offscreen-note-indicator absolute flex h-6 -translate-y-1/2 items-center gap-0.5 rounded-full border bg-preview px-1 text-xs tabular-nums text-white shadow-sm"
                    :class="[
                        indicator.side === 'left' ? 'left-1' : 'right-1 flex-row-reverse',
                        indicator.highlighted ? 'border-white' : 'border-white/25',
                        indicator === hovered && 'is-hovered ring-2 ring-accent',
                    ]"
                    :style="{ top: `${indicator.y}px`, opacity: indicator.opacity }"
                    :data-side="indicator.side"
                    :data-count="indicator.count"
                    :data-selectable="indicator.targets.length"
                    role="img"
                    :aria-label="
                        interpolateRaw(i18n.offscreenNotes[indicator.side], String(indicator.count))
                    "
                >
                    <ChevronIcon :direction="indicator.side" />
                    <span>{{ indicator.count }}</span>
                </div>
            </div>
        </div>
    </div>
</template>
