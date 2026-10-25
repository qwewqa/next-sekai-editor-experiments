<script setup lang="ts">
// The one bar under a wait's status text. Without `value` it slides, for a wait of unknown length.
// With `value` (0 to 100) it fills to the fraction. Under reduced motion the sliding bar fills the
// track and pulses, so a wait still looks live. The text beside it names the work; the bar shows
// the fraction.
defineProps<{
    value?: number
    /** The id of the status text, for a bar that shows a value. */
    labelledby?: string
}>()
</script>

<template>
    <div
        class="h-1 overflow-hidden rounded-full bg-fg/20"
        :role="value === undefined ? undefined : 'progressbar'"
        :aria-hidden="value === undefined ? 'true' : undefined"
        :aria-labelledby="value === undefined ? undefined : labelledby"
        :aria-valuemin="value === undefined ? undefined : 0"
        :aria-valuemax="value === undefined ? undefined : 100"
        :aria-valuenow="value"
    >
        <div
            v-if="value !== undefined"
            class="h-full rounded-full bg-fg"
            :style="{ width: `${value}%` }"
        />
        <div v-else class="wait-bar-slide h-full w-1/3 rounded-full bg-fg" />
    </div>
</template>

<style scoped>
.wait-bar-slide {
    animation: wait-bar-slide 1.1s ease-in-out infinite;
}

@keyframes wait-bar-slide {
    from {
        transform: translateX(-100%);
    }
    to {
        transform: translateX(300%);
    }
}

/* Tailwind's pulse only dips to half opacity, which a fill at 40% would hardly show. */
@media (prefers-reduced-motion: reduce) {
    .wait-bar-slide {
        width: 100%;
        animation: wait-bar-pulse 1.5s ease-in-out infinite;
    }
}

@keyframes wait-bar-pulse {
    0%,
    100% {
        opacity: 0.15;
    }
    50% {
        opacity: 0.5;
    }
}
</style>
