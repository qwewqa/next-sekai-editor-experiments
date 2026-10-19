<script setup lang="ts">
import AddIcon from './icons/AddIcon.vue'

defineProps<{ label: string }>()
</script>

<template>
    <!-- A raised white pill, laid out like a row: the plus on the eye column,
    the label on the names. -->
    <button
        type="button"
        class="manager-add btn btn-secondary pointer-events-auto flex items-center rounded-full p-0.5 pr-4"
    >
        <span class="flex size-9 shrink-0 items-center justify-center">
            <AddIcon class="size-4 fill-current" aria-hidden="true" />
        </span>
        <span class="pl-2">{{ label }}</span>
    </button>
</template>
