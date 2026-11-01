<script setup lang="ts">
import { i18n } from '../../i18n'
import MultiNumberField from './MultiNumberField.vue'
import { usePropertyDescription } from './propertyDescription'

const modelValue = defineModel<number | undefined>({ required: true })
const description = usePropertyDescription((t) => t.modals.form.descriptions.cameraSize)
</script>

<template>
    <MultiNumberField
        v-model="modelValue"
        :description
        :label="i18n.modals.form.cameraSize.label"
        :min="6"
        :max="24"
        step="any"
    />
</template>
