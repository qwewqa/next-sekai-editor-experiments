<script setup lang="ts">
import { computed, useId } from 'vue'
import { i18n } from '../../../i18n'

// The chooser's switch between a file and a server (Part 2, 2.6): a segmented control in the
// editor's style, two radios in a group.
const mode = defineModel<'file' | 'server'>({ required: true })
defineProps<{
    /** Names the group: the chooser's title. */
    label: string
    disabled?: boolean
}>()

const strings = computed(() => i18n.value.commands.previewAssets)
const name = useId()

// High contrast paints only the outlines: the track's is its edge, the segment's shows focus.
// The selected segment is the raised pill; a press steps it, as it does a raised button.
const segment =
    'chooser-mode-segment flex h-7 items-center justify-center rounded-full px-3 transition-colors peer-checked:bg-button peer-checked:shadow-md peer-hover:bg-button/50 peer-checked:peer-hover:bg-button peer-active:bg-ghost-press peer-active:text-fg-strong peer-checked:peer-active:bg-press'
const choice =
    'relative min-w-0 flex-1 rounded-full has-[:checked]:outline has-[:checked]:outline-1 has-[:checked]:outline-transparent'
</script>

<template>
    <div
        class="flex min-w-0 max-w-md rounded-full bg-recess p-0.5 shadow-track"
        :class="{ 'pointer-events-none opacity-40': disabled }"
        role="radiogroup"
        :aria-label="label"
        data-chooser-mode
    >
        <label v-for="item in ['file', 'server'] as const" :key="item" :class="choice">
            <input
                v-model="mode"
                class="peer absolute inset-0 size-full cursor-pointer opacity-0"
                type="radio"
                :name
                :value="item"
                :disabled
                :data-chooser-mode-option="item"
            />
            <span :class="segment"
                ><span class="truncate">{{
                    item === 'file' ? strings.fromFile : strings.fromServer
                }}</span></span
            >
        </label>
    </div>
</template>

<style scoped>
/* The face is under 32px, so the focus ring sits 1px outside it, in the surface's ink (the
   `focus-out` rule, which cannot reach a sibling of the focused radio). */
.peer:focus-visible + .chooser-mode-segment {
    outline: 2px solid rgb(var(--color-fg));
    outline-offset: 1px;
}
</style>
