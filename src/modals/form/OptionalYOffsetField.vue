<script setup lang="ts">
import { i18n } from '../../i18n'
import OptionalNumberField from './OptionalNumberField.vue'
import { usePropertyDescription } from './propertyDescription'

const modelValue = defineModel<number | undefined>({ required: true })
const description = usePropertyDescription((t) => t.modals.form.descriptions.yOffset)
</script>

<template>
    <OptionalNumberField
        v-model="modelValue"
        :description
        :label="i18n.modals.form.yOffset.label"
        step="any"
    />
</template>
