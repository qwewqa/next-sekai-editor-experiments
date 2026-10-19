<script setup lang="ts">
import { computed, type Component } from 'vue'
import type { NamePart } from '../chart/folders'

const props = defineProps<{
    compact: boolean
    parts: NamePart[]
    path: NamePart[]
    icon: Component
    iconsOnly: boolean
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
        class="status-chip ghost focus-out ghost-chrome relative flex items-center whitespace-nowrap px-1"
        :class="compact ? (iconsOnly ? 'justify-center' : 'gap-1') : ''"
        :aria-label="accessibleName"
        @click="$emit('click', $event)"
    >
        <template v-if="compact">
            <component :is="icon" class="size-3 shrink-0 fill-current" aria-hidden="true" />
            <span v-if="!iconsOnly" class="flex min-w-0" aria-hidden="true" data-status-target>
                <span
                    v-for="(part, i) in path"
                    :key="i"
                    :class="
                        part.role === 'folder'
                            ? 'status-folder min-w-[2em] truncate'
                            : part.role === 'name'
                              ? 'min-w-[2em] truncate'
                              : 'shrink-0 whitespace-pre'
                    "
                    :data-status-part="part.role"
                    >{{ part.text }}</span
                >
            </span>
        </template>
        <template v-else>
            <span class="flex min-w-0" aria-hidden="true">
                <span
                    v-for="(part, i) in parts"
                    :key="i"
                    :class="partClass(part)"
                    :data-status-part="part.role"
                    >{{ part.text }}</span
                >
            </span>
            <span
                v-if="count"
                class="ml-1 shrink-0 whitespace-nowrap"
                :title="count.label"
                data-status-count
                aria-hidden="true"
                >· {{ count.short }}</span
            >
        </template>
    </button>
</template>

<style scoped>
.status-chip {
    height: var(--status-row-height);
    border-radius: 9999px;
}

.status-folder {
    flex-shrink: 1000;
}
</style>
