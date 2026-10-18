<script setup lang="ts">
import { computed } from 'vue'
import { chipSeverity } from './chip'
import { chipSentence, chipText, openChipDialog } from './chipDialogs'
import { chip } from './state'

defineProps<{ compact: boolean }>()

// The one state chip after the status label (Part 1 §1.3.4): the highest-priority state, its
// own button with an icon drawn by severity. It never shrinks away; on phones it shows the short
// label, with the full sentence as its accessible name.
const severity = computed(() => (chip.value ? chipSeverity(chip.value.kind) : undefined))
</script>

<template>
    <button
        v-if="chip"
        type="button"
        class="file-chip relative flex shrink-0 items-center gap-1 px-1"
        :aria-label="chipSentence(chip.kind)"
        :data-file-chip="chip.kind"
        @click="openChipDialog"
    >
        <svg
            class="size-3 shrink-0 fill-current"
            :class="severity === 'warning' ? 'text-amber-300' : 'text-sky-300'"
            viewBox="0 0 16 16"
            aria-hidden="true"
        >
            <path
                v-if="severity === 'warning'"
                fill-rule="evenodd"
                d="M8 1 15.5 14.5h-15zM7.2 5.5h1.6l-.3 4.5H7.5zM8 11.2a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8z"
            />
            <path
                v-else
                fill-rule="evenodd"
                d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm-.8 3.2h1.6v1.6H7.2zm0 3h1.6v4.6H7.2z"
            />
        </svg>
        <span class="whitespace-nowrap" aria-hidden="true">{{ chipText(chip.kind, compact) }}</span>
    </button>
</template>

<style scoped>
.file-chip {
    border-radius: 9999px;
    transition: color 150ms;
}

@media (any-pointer: coarse) {
    .file-chip {
        min-width: 44px;
    }
}

.file-chip:active {
    color: theme('colors.white');
}

.file-chip:focus-visible {
    outline: 2px solid transparent;
    box-shadow: 0 0 0 2px theme('colors.accent');
}

@media (hover: hover) {
    .file-chip:hover {
        color: theme('colors.white');
    }
}
</style>
