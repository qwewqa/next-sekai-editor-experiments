<script setup lang="ts">
defineProps<{
    fill?: string
    /** The generic event: a disc of the button colour; a ring in the text colour under high contrast. */
    monochrome?: boolean
}>()
</script>

<template>
    <svg viewBox="-0.5 -0.5 1 1">
        <circle
            class="stroke-current"
            :class="{ 'fill-button forced-colors:fill-transparent': monochrome }"
            cx="0"
            cy="0"
            r="0.25"
            stroke-width="0.05"
            :fill
        />
    </svg>
</template>
