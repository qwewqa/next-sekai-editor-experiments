<script setup lang="ts">
import { i18n } from '../../i18n'
import { usePropertyDescription } from './propertyDescription'
import ToggleField from './ToggleField.vue'

const modelValue = defineModel<boolean>({ required: true })
const description = usePropertyDescription((t) => t.modals.form.descriptions.isFromStart)
</script>

<template>
    <ToggleField v-model="modelValue" :label="i18n.modals.form.isFromStart.label" :description />
</template>
