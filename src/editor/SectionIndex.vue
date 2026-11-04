<script setup lang="ts" generic="Id extends string">
import { vScrollEdges } from '../directives/scrollEdges'

defineProps<{
    items: readonly { id: Id; label: string }[]
    /** The accessible name of the navigation. */
    label: string
    /** The attribute that marks the navigation, and the one that marks each pill with its id. */
    indexAttribute: string
    pillAttribute: string
}>()

defineEmits<{
    go: [id: Id]
}>()

const pill = 'btn btn-secondary h-8 shrink-0 rounded-full px-3 text-sm'
</script>

<template>
    <!-- The section index: one swipeable row of pills on touch, which fades at the edge that has
    more; a mouse has no swipe, so the pills wrap and none is hidden. -->
    <nav
        v-scroll-edges:x
        :aria-label="label"
        class="flex shrink-0 gap-2 overflow-x-auto scrollbar-none [&::-webkit-scrollbar]:hidden pointer-fine:flex-wrap pointer-fine:overflow-x-visible"
        v-bind="{ [indexAttribute]: '' }"
    >
        <button
            v-for="item in items"
            :key="item.id"
            type="button"
            :class="pill"
            v-bind="{ [pillAttribute]: item.id }"
            @click="$emit('go', item.id)"
        >
            {{ item.label }}
        </button>
    </nav>
</template>
