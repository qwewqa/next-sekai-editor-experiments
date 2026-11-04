<script setup lang="ts">
// The distribution's key: Tap and Flick's line and All's area, as the plot draws them.

defineProps<{ primary: string; all: string }>()
</script>

<template>
    <span class="stats-series-key">
        <span class="stats-series-item">
            <svg width="18" height="8" viewBox="0 0 18 8" aria-hidden="true">
                <line class="stats-line thick" x1="1" x2="17" y1="4" y2="4" />
            </svg>
            {{ primary }}
        </span>
        <span class="stats-series-item">
            <svg width="18" height="8" viewBox="0 0 18 8" aria-hidden="true">
                <rect class="stats-all-fill" width="18" height="8" />
                <line class="stats-all-edge" x1="0" x2="18" y1="0.5" y2="0.5" />
            </svg>
            {{ all }}
        </span>
    </span>
</template>
