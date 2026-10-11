<script setup lang="ts">
import { computed } from 'vue'
import OffscreenNoteBadge from './OffscreenNoteBadge.vue'
import type { OffscreenNoteGroup } from './offscreenNotes'

const props = defineProps<{
    groups: OffscreenNoteGroup[]
    hovered?: OffscreenNoteGroup
    // Pane y the badges are placed from.
    anchor: number
}>()

const scrolling = computed(() => props.groups.filter(({ fixed }) => !fixed))
const fixed = computed(() => props.groups.filter(({ fixed }) => fixed))
</script>

<template>
    <div class="pointer-events-none absolute inset-0 overflow-hidden">
        <!-- Scrolling moves only this layer; the badges re-render when they change. -->
        <div
            class="absolute inset-x-0 top-0 will-change-transform"
            data-layer="anchored"
            :style="{ transform: `translateY(${anchor}px)` }"
        >
            <div v-memo="[scrolling, hovered]">
                <OffscreenNoteBadge
                    v-for="indicator in scrolling"
                    :key="`${indicator.side}:${indicator.slot}`"
                    :indicator="indicator"
                    :hovered="indicator === hovered"
                />
            </div>
        </div>
        <!-- Badges held at the edges. -->
        <div class="absolute inset-x-0 top-0" data-layer="fixed">
            <div v-memo="[fixed, hovered]">
                <OffscreenNoteBadge
                    v-for="indicator in fixed"
                    :key="`${indicator.side}:${indicator.slot}`"
                    :indicator="indicator"
                    :hovered="indicator === hovered"
                />
            </div>
        </div>
    </div>
</template>
