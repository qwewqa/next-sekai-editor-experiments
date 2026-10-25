<script setup lang="ts">
import WaitBar from '../../workspace/WaitBar.vue'

// The inline progress of the From a Server view: a line of text and a bar that slides. It shows
// inside a live region that stays mounted, so the text is announced.
defineProps<{
    text: string
}>()
</script>

<template>
    <div class="px-2" data-chooser-progress>
        <p class="text-sm">{{ text }}</p>
        <WaitBar class="mt-1" />
    </div>
</template>
