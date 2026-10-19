<script setup lang="ts">
import { inject, useId, watch } from 'vue'
import { vScrollEdges } from '../directives/scrollEdges'
import CloseIcon from '../editor/workspace/CloseIcon.vue'
import { i18n } from '../i18n'
import { modalTitleKey } from './title'

const props = defineProps<{
    title: string
    /** The body neither pads nor scrolls; its content fills it and scrolls itself. */
    fill?: boolean
}>()

const slots = defineSlots<{
    default(): unknown
    /** Replaces the visible title, e.g. with tabs; the title still names the dialog. */
    header?(): unknown
}>()

// Only the editor's tool-modal host provides a title; its panels use the
// Heading size, while top-level dialogs keep the larger Title size.
const modalTitle = inject(modalTitleKey, undefined)
if (modalTitle)
    watch(
        () => props.title,
        (title) => (modalTitle.value = title),
        { immediate: true },
    )

defineEmits<{
    close: []
}>()

// The dialog around it is named by this title.
const titleId = useId()
</script>

<template>
    <div
        class="flex h-12 shrink-0 items-center justify-between gap-2 bg-header pr-1.5 font-bold"
        :class="[modalTitle ? 'text-base' : 'text-lg', slots.header ? 'pl-1.5' : 'pl-4']"
    >
        <span
            :id="titleId"
            :class="slots.header ? 'sr-only' : 'min-w-0 truncate'"
            data-modal-title
            :title="slots.header ? undefined : title"
            >{{ title }}</span
        >
        <slot name="header" />
        <button
            type="button"
            class="ghost ghost-band flex size-9 shrink-0 items-center justify-center rounded-full"
            :aria-label="i18n.modals.close"
            :title="i18n.modals.close"
            @click="$emit('close')"
        >
            <CloseIcon class="size-4" />
        </button>
    </div>

    <div v-if="fill" class="relative flex min-h-0 flex-1 flex-col">
        <slot />
    </div>
    <div v-else v-scroll-edges class="relative flex min-h-0 flex-col gap-4 overflow-y-auto p-4">
        <slot />
    </div>
</template>
