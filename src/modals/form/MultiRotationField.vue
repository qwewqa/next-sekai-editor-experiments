<script setup lang="ts">
import { i18n } from '../../i18n/index.ts'
import MultiNumberField from './MultiNumberField.vue'
import { usePropertyDescription } from './propertyDescription'

const modelValue = defineModel<number | undefined>({ required: true })
const description = usePropertyDescription((t) => t.modals.form.descriptions.rotation)
</script>

<template>
    <MultiNumberField
        v-model="modelValue"
        :description
        :label="i18n.modals.form.rotation.label"
        step="any"
    />
</template>
