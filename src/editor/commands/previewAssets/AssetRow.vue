<script setup lang="ts">
import { shallowRef, watch } from 'vue'
import type { AssetType } from '../../../preview/assets'
import AssetGlyph from './AssetGlyph.vue'

// One radio row of a source list or of the chooser: a 40 px picture, a name and a detail line.
const props = defineProps<{
    type: AssetType
    name: string
    /** The author, and for a stored item its origin. */
    detail?: string
    image?: string
    checked: boolean
    group: string
    /** Takes focus when the dialog opens. */
    autofocus?: boolean
    describedby?: string
}>()

defineEmits<{
    select: []
}>()

// A picture that fails to load (a server's) gives way to the type's glyph.
const failed = shallowRef(false)
watch(
    () => props.image,
    () => (failed.value = false),
)
</script>

<template>
    <label
        class="asset-row relative flex min-h-12 cursor-pointer items-center gap-3 rounded-xl px-3 py-1 transition-colors has-[:active]:bg-accent has-[:checked]:bg-button has-[:active]:text-on-accent has-[:checked]:shadow-md has-[:checked]:outline has-[:checked]:outline-1 has-[:checked]:outline-transparent has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-fg [@media(hover:hover)]:hover:bg-band-hover [@media(hover:hover)]:has-[:checked]:hover:bg-button [@media(pointer:coarse)]:min-h-14"
    >
        <input
            type="radio"
            class="peer absolute inset-0 size-full cursor-pointer opacity-0 focus-visible:outline-none"
            :name="group"
            :checked="checked"
            :data-autofocus="autofocus || undefined"
            :aria-describedby="describedby"
            @change="$emit('select')"
        />
        <span
            class="pointer-events-none relative size-4 shrink-0 rounded-full border-2 border-fg after:absolute after:inset-0.5 after:scale-0 after:rounded-full after:bg-fg after:transition-transform peer-checked:after:scale-100"
            aria-hidden="true"
        />
        <span
            class="pointer-events-none flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-recess"
            aria-hidden="true"
        >
            <img
                v-if="image && !failed"
                :src="image"
                alt=""
                referrerpolicy="no-referrer"
                class="size-full object-cover"
                @error="failed = true"
            />
            <AssetGlyph v-else :type="type" class="opacity-60" />
        </span>
        <span class="pointer-events-none min-w-0 flex-1">
            <span class="block truncate" data-asset-row-name>{{ name }}</span>
            <span v-if="detail" class="block truncate text-sm opacity-75">{{ detail }}</span>
        </span>
    </label>
</template>
