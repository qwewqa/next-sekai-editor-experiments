<script setup lang="ts">
// The inline progress of the From a Server view: a line of text and a bar that slides.
defineProps<{
    text: string
}>()
</script>

<template>
    <div class="px-2" role="status" data-chooser-progress>
        <p class="text-sm">{{ text }}</p>
        <div class="chooser-bar mt-1 h-1 overflow-hidden rounded-full bg-fg/20" aria-hidden="true">
            <div class="chooser-bar-fill h-full w-1/3 rounded-full bg-fg" />
        </div>
    </div>
</template>

<style scoped>
.chooser-bar-fill {
    animation: chooser-slide 1.1s ease-in-out infinite;
}

@keyframes chooser-slide {
    from {
        transform: translateX(-100%);
    }
    to {
        transform: translateX(300%);
    }
}

@media (prefers-reduced-motion: reduce) {
    .chooser-bar-fill {
        animation: none;
        width: 100%;
        opacity: 0.4;
    }
}
</style>
