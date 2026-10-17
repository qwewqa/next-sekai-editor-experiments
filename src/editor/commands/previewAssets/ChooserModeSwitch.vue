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
const segment =
    'flex h-7 items-center justify-center rounded-full px-3 transition-colors peer-checked:bg-button peer-checked:shadow-md peer-hover:bg-button/50 peer-checked:peer-hover:bg-button peer-focus-visible:ring-2 peer-focus-visible:ring-fg peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-transparent peer-active:bg-accent peer-active:text-on-accent peer-checked:peer-active:bg-accent forced-colors:peer-focus-visible:outline-[color:Highlight] [@media(pointer:coarse)]:h-10'
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
                class="peer absolute inset-0 size-full cursor-pointer opacity-0 focus-visible:outline-none"
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
