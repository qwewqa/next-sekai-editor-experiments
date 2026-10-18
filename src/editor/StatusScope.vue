<script setup lang="ts">
import { computed } from 'vue'
import type { NamePart } from '../chart/folders'

const props = defineProps<{
    compact: boolean
    parts: NamePart[]
    target: NamePart[]
    folder?: string
    count?: { short: string; label: string }
}>()
defineEmits<{ click: [event: MouseEvent] }>()

const accessibleName = computed(() =>
    [props.parts.map(({ text }) => text).join(''), props.count?.label].filter(Boolean).join(' '),
)
const partClass = ({ text, role }: NamePart) =>
    role === 'folder'
        ? text.length > 2
            ? 'status-folder min-w-[2em] truncate'
            : 'shrink-0'
        : role === 'name'
          ? 'min-w-0 truncate'
          : 'shrink-0 whitespace-pre'
</script>

<template>
    <button
        type="button"
        class="status-chip relative flex items-center px-1"
        :aria-label="accessibleName"
        @click="$emit('click', $event)"
    >
        <span v-if="compact" class="flex w-full min-w-0 flex-col" aria-hidden="true">
            <span class="flex min-w-0" data-status-target>
                <span
                    v-for="(part, i) in target"
                    :key="i"
                    :class="part.role === 'name' ? 'min-w-0 truncate' : 'shrink-0 whitespace-pre'"
                    :data-status-part="part.role"
                    >{{ part.text }}</span
                >
            </span>
            <span v-if="folder || count" class="flex min-w-0" data-status-metadata>
                <span v-if="folder" class="status-folder min-w-0 flex-1 truncate" data-status-part="folder">{{ folder }}</span>
                <span v-if="count" class="status-count min-w-0 max-w-full shrink-0 truncate" :class="folder ? 'ml-1' : ''" :title="count.label" data-status-count>· {{ count.short }}</span>
            </span>
        </span>
        <template v-else>
            <span class="flex min-w-0" aria-hidden="true">
                <span v-for="(part, i) in parts" :key="i" :class="partClass(part)" :data-status-part="part.role">{{ part.text }}</span>
            </span>
            <span v-if="count" class="ml-1 shrink-0 whitespace-nowrap" :title="count.label" data-status-count aria-hidden="true">· {{ count.short }}</span>
        </template>
    </button>
</template>

<style scoped>
.status-chip {
    height: var(--status-row-height);
    border-radius: 9999px;
    transition: color 150ms;
}

.status-folder {
    flex-shrink: 1000;
}

.status-chip:active {
    color: theme('colors.white');
}

.status-chip:focus-visible {
    outline: 2px solid transparent;
    box-shadow: 0 0 0 2px theme('colors.accent');
}

@media (hover: hover) {
    .status-chip:hover {
        color: theme('colors.white');
    }
}
</style>
