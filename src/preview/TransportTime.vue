<script setup lang="ts">
import { computed } from 'vue'
import { view } from '../editor/view'
import { formatTime } from '../utils/format'

// Only the cursor time changes on every playback frame. Reading it here keeps the rest of the
// transport (its buttons and their labels) from re-rendering with it.
const text = computed(() => formatTime(Math.round(view.cursorTime * 1000) / 1000))
</script>

<template>{{ text }}</template>
