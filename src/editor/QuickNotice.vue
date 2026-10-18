<script setup lang="ts">
import type { Notice } from './notification'

// Quick feedback, as v0.5.22 drew it: a mint pill that fades to a ghost over a second, with no input.
defineProps<{ notice: Notice }>()
</script>

<template>
    <div class="notification whitespace-break-spaces rounded-full px-6 py-2 text-center">
        {{ notice.message?.() }}
    </div>
</template>

<style scoped>
.notification {
    animation-name: fade;
    animation-duration: 1s;
    animation-fill-mode: forwards;
}

@keyframes fade {
    0% {
        z-index: 100;
        /* Dark text on mint, as on every accent fill (8.9:1). */
        color: theme('colors.on-accent');
        background-color: theme('colors.accent');
    }

    99% {
        z-index: 100;
    }

    100% {
        color: rgb(255 255 255 / 0.25);
        background-color: theme('colors.accent / 0%');
    }
}
</style>
