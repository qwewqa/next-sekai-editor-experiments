<script setup lang="ts">
// The icon of a row's flag (Part 1 §1.4.10.5): a barred circle for an entry removed to save space,
// a circled exclamation mark for one that could not be read. 16px, in the text colour.
defineProps<{ kind: 'removed' | 'damaged' }>()
</script>

<template>
    <svg class="size-3.5 shrink-0 fill-current" viewBox="0 0 16 16" aria-hidden="true">
        <path
            v-if="kind === 'removed'"
            fill-rule="evenodd"
            d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM3 8a5 5 0 0 1 8.2-3.85L4.15 11.2A5 5 0 0 1 3 8Zm2.8 3.85 7.05-7.05A5 5 0 0 1 5.8 11.85Z"
        />
        <path
            v-else
            fill-rule="evenodd"
            d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM7.25 4.5h1.5v4.5h-1.5V4.5Zm0 5.75h1.5v1.5h-1.5v-1.5Z"
        />
    </svg>
</template>
