<script setup lang="ts">
import { computed } from 'vue'

// Text whose parts are joined with " · ", shown where it can wrap. Each separator stays on the
// line of the part before it, so a wrapped line never starts with one. The rendered text matches
// the input.
const props = defineProps<{ text: string }>()
const parts = computed(() => props.text.split(' · '))
</script>

<template>
    <template v-for="(part, index) in parts" :key="index"
        >{{ index ? ' ' : '' }}{{ part
        }}<span v-if="index < parts.length - 1" class="whitespace-nowrap">{{
            ' ·'
        }}</span></template
    >
</template>
