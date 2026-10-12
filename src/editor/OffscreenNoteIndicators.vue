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
// By key: a reused subset holds older objects than the hit test returns.
const hoveredKey = computed(() => props.hovered && `${props.hovered.side}:${props.hovered.slot}`)
</script>

<template>
    <div class="offscreen-notes pointer-events-none absolute inset-0 overflow-hidden">
        <!-- Badges held at the top edge, or the short band's one badge. -->
        <div v-memo="[top, hoveredKey]" class="absolute inset-x-0 top-0">
            <OffscreenNoteBadge
                v-for="indicator in top"
                :key="`${indicator.side}:${indicator.slot}`"
                :indicator="indicator"
                :hovered="`${indicator.side}:${indicator.slot}` === hoveredKey"
            />
        </div>
        <!-- Scrolling moves only this layer; the badges re-render when they change. -->
        <div class="absolute inset-x-0 top-0" :style="{ transform: `translateY(${anchor}px)` }">
            <div v-memo="[scrolling, hoveredKey]">
                <OffscreenNoteBadge
                    v-for="indicator in scrolling"
                    :key="`${indicator.side}:${indicator.slot}`"
                    :indicator="indicator"
                    :hovered="`${indicator.side}:${indicator.slot}` === hoveredKey"
                />
            </div>
        </div>
        <!-- Badges held at the bottom edge. -->
        <div v-memo="[bottom, hoveredKey]" class="absolute inset-x-0 top-0">
            <OffscreenNoteBadge
                v-for="indicator in bottom"
                :key="`${indicator.side}:${indicator.slot}`"
                :indicator="indicator"
                :hovered="`${indicator.side}:${indicator.slot}` === hoveredKey"
            />
        </div>
    </div>
</template>
