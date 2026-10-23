<script setup lang="ts">
import { useId } from 'vue'
import BaseField from '../../modals/form/BaseField.vue'

// A labelled media row of Level Info (Part 1 §1.4.12): what the slot holds on one line, its
// actions beside or below it. The label is the group's name.
defineProps<{
    label: string
    /** The line: a name and its facts, or the empty slot's text. */
    summary: string
}>()

const id = useId()
</script>

<template>
    <BaseField :label :label-id="id" class="level-info-media">
        <div role="group" :aria-labelledby="id" class="flex min-w-0 flex-wrap items-center gap-2">
            <slot name="lead" />
            <span
                class="min-w-0 flex-1 basis-32 select-text break-words [overflow-wrap:anywhere]"
                >{{ summary }}</span
            >
            <div v-if="$slots.default" class="flex max-w-full flex-wrap gap-2">
                <slot />
            </div>
        </div>
    </BaseField>
</template>
