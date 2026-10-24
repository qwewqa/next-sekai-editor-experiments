<script setup lang="ts">
import { computed, useId } from 'vue'
import { i18n } from '../../../i18n'

// The chooser's switch between a file and a server: a segmented control in the
// editor's style, two radios in a group.
const mode = defineModel<'file' | 'server'>({ required: true })
defineProps<{
    /** Names the group: the chooser's title. */
    label: string
    disabled?: boolean
}>()

const strings = computed(() => i18n.value.commands.previewAssets)
const name = useId()

// The segment recipes in controls.css: the selected segment is the raised pill, a press steps it, and
// high contrast paints the checked label's edge and the focused segment's ring.
const segment = 'segment-face h-7 px-3'
const choice = 'segment-choice relative min-w-0 flex-1'
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
