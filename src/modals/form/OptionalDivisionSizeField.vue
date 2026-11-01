<script setup lang="ts">
import { i18n } from '../../i18n'
import OptionalNumberField from './OptionalNumberField.vue'
import { usePropertyDescription } from './propertyDescription'

const modelValue = defineModel<number | undefined>({ required: true })
const description = usePropertyDescription((t) => t.modals.form.descriptions.divisionSize)
</script>

<template>
    <OptionalNumberField
        v-model="modelValue"
        :description
        :label="i18n.modals.form.divisionSize.label"
        :min="1"
        :step="1"
    />
</template>
