<script setup lang="ts">
import type { BorderStyle } from '../../chart/events/stage/style'
import { i18n } from '../../i18n'
import type { ChoiceDescription } from './fieldDescription'
import MultiSelectField from './MultiSelectField.vue'

defineProps<{
    label: string
    /** A line per style, behind an ⓘ. */
    description?: ChoiceDescription<BorderStyle> | null
}>()

const modelValue = defineModel<BorderStyle | undefined>({ required: true })
</script>

<template>
    <MultiSelectField
        v-model="modelValue"
        :label
        :description
        :options="[
            [i18n.modals.form.borderStyle.default, 'default'],
            [i18n.modals.form.borderStyle.light, 'light'],
            [i18n.modals.form.borderStyle.medium, 'medium'],
            [i18n.modals.form.borderStyle.disabled, 'disabled'],
        ]"
    />
</template>
