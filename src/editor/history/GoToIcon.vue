<script setup lang="ts">
// Go To's icon (Part 1 §1.4.10.5): a calendar. A small accent dot on it says the list is filtered.
defineProps<{ filtered?: boolean }>()
</script>

<template>
    <span class="relative flex size-4 shrink-0" aria-hidden="true">
        <svg class="size-4 fill-current" viewBox="0 0 16 16">
            <path
                fill-rule="evenodd"
                d="M4.5 1a.75.75 0 0 1 .75.75V3h5.5V1.75a.75.75 0 0 1 1.5 0V3H13a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 13 14H3a1.5 1.5 0 0 1-1.5-1.5v-8A1.5 1.5 0 0 1 3 3h.75V1.75A.75.75 0 0 1 4.5 1ZM3 6.5v6h10v-6H3Z"
            />
        </svg>
        <span
            v-if="filtered"
            class="absolute -right-1 -top-1 size-2 rounded-full bg-accent ring-2 ring-button forced-colors:bg-[Highlight]"
            data-filter-dot
        />
    </span>
</template>
