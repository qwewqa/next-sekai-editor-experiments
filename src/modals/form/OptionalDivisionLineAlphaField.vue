<script setup lang="ts">
import { i18n } from '../../i18n'
import OptionalNumberField from './OptionalNumberField.vue'
import { usePropertyDescription } from './propertyDescription'

const modelValue = defineModel<number | undefined>({ required: true })
const description = usePropertyDescription((t) => t.modals.form.descriptions.divisionLineAlpha)
</script>

<template>
    <OptionalNumberField
        v-model="modelValue"
        :description
        :label="i18n.modals.form.divisionLineAlpha.label"
        :min="0"
        :max="1"
        step="any"
    />
</template>
