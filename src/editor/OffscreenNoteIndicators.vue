<script setup lang="ts">
import { computed } from 'vue'
import OffscreenNoteBadge from './OffscreenNoteBadge.vue'
import { isSameOffscreenGroups, type OffscreenNoteGroup } from './offscreenNotes'

const props = defineProps<{
    groups: OffscreenNoteGroup[]
    hovered?: OffscreenNoteGroup
    // Pane y the badges are placed from.
    anchor: number
}>()

// Unchanged subsets keep their array, so a change at an edge doesn't re-render the scrolling badges.
const subset = (pick: (group: OffscreenNoteGroup) => boolean, sort = false) =>
    computed<OffscreenNoteGroup[]>((previous) => {
        const groups = props.groups.filter(pick)
        if (sort) groups.sort((a, b) => a.y - b.y)
        return previous && isSameOffscreenGroups(previous, groups) ? previous : groups
    })
// Top to bottom, in the order they are read.
const top = subset(({ fixed, slot }) => fixed && slot !== Infinity)
const scrolling = subset(({ fixed }) => !fixed, true)
const bottom = subset(({ slot }) => slot === Infinity)
</script>

<template>
    <div class="pointer-events-none absolute inset-0 overflow-hidden">
        <!-- Badges held at the top edge. -->
        <div v-memo="[top, hovered]" class="absolute inset-x-0 top-0">
            <OffscreenNoteBadge
                v-for="indicator in top"
                :key="`${indicator.side}:${indicator.slot}`"
                :indicator="indicator"
                :hovered="indicator === hovered"
            />
        </div>
        <!-- Scrolling moves only this layer; the badges re-render when they change. -->
        <div class="absolute inset-x-0 top-0" :style="{ transform: `translateY(${anchor}px)` }">
            <div v-memo="[scrolling, hovered]">
                <OffscreenNoteBadge
                    v-for="indicator in scrolling"
                    :key="`${indicator.side}:${indicator.slot}`"
                    :indicator="indicator"
                    :hovered="indicator === hovered"
                />
            </div>
        </div>
        <!-- Badges held at the bottom edge. -->
        <div v-memo="[bottom, hovered]" class="absolute inset-x-0 top-0">
            <OffscreenNoteBadge
                v-for="indicator in bottom"
                :key="`${indicator.side}:${indicator.slot}`"
                :indicator="indicator"
                :hovered="indicator === hovered"
            />
        </div>
    </div>
</template>
