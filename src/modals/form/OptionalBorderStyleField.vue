<script setup lang="ts">
import type { BorderStyle } from '../../chart/events/stage/style'
import { i18n } from '../../i18n'
import OptionalSelectField from './OptionalSelectField.vue'

defineProps<{
    label: string
    /** The side's sentence before the styles' lines, behind an ⓘ. */
    description?: string | null
}>()

const modelValue = defineModel<BorderStyle | undefined>({ required: true })
</script>

<template>
    <OptionalSelectField
        v-model="modelValue"
        :label
        :description="
            description && {
                intro: description,
                choices: i18n.modals.form.descriptions.borderStyle.choices,
            }
        "
        :options="[
            [i18n.modals.form.borderStyle.default, 'default'],
            [i18n.modals.form.borderStyle.light, 'light'],
            [i18n.modals.form.borderStyle.medium, 'medium'],
            [i18n.modals.form.borderStyle.disabled, 'disabled'],
        ]"
    />
</template>
