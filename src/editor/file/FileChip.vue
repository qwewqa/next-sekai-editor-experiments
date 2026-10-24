<script setup lang="ts">
import { computed } from 'vue'
import { vFocusRescue } from '../../directives/focusRescue'
import { chipSeverity } from './chip'
import { chipSentence, chipText, openChipDialog } from './chipDialogs'
import { chip } from './state'

defineProps<{ compact: boolean }>()

// The one state chip after the status label: the highest-priority state, its
// own button with an icon drawn by severity. Compact bars show the icon, with the full sentence
// as its accessible name.
const severity = computed(() => (chip.value ? chipSeverity(chip.value.kind) : undefined))
</script>

<template>
    <button
        v-if="chip"
        v-focus-rescue
        type="button"
        class="file-chip ghost focus-out ghost-chrome relative flex shrink-0 items-center gap-1"
        :class="compact ? 'w-6 justify-center' : 'px-1'"
        :aria-label="chipSentence(chip.kind)"
        :title="chipSentence(chip.kind)"
        :data-file-chip="chip.kind"
        @click="openChipDialog"
    >
        <svg
            class="size-3 shrink-0 fill-current"
            :class="severity === 'warning' ? 'text-warning' : 'text-info'"
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
        <span v-if="!compact" class="whitespace-nowrap" aria-hidden="true">{{
            chipText(chip.kind)
        }}</span>
    </button>
</template>

<style scoped>
.file-chip {
    height: var(--status-row-height);
    border-radius: 9999px;
}
</style>
