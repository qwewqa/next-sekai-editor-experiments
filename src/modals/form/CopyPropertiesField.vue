<script setup lang="ts">
import { i18n } from '../../i18n'
import { usePropertyDescription } from './propertyDescription'
import ToggleField from './ToggleField.vue'

const props = defineProps<{
    /** Shows the Slide tool's own description. */
    slide?: boolean
}>()

const modelValue = defineModel<boolean>({ required: true })
const description = usePropertyDescription((t) =>
    props.slide
        ? t.modals.form.descriptions.copyPropertiesSlide
        : t.modals.form.descriptions.copyProperties,
)
</script>

<template>
    <ToggleField v-model="modelValue" :label="i18n.modals.form.copyProperties.label" :description />
</template>
