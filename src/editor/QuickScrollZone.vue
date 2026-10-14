<script setup lang="ts">
import { isQuickScrollZoneShown, quickScrollWidth } from './quickScroll'

defineProps<{ paneWidth: number }>()
</script>

<template>
    <div
        v-if="isQuickScrollZoneShown"
        class="editor-quick-scroll-zone pointer-events-none absolute inset-y-0 right-0 bg-black/25"
        :style="{ width: `${quickScrollWidth(paneWidth)}px` }"
    />
</template>

<style scoped>
@media (forced-colors: active) {
    .editor-quick-scroll-zone {
        display: none;
    }
}
</style>
