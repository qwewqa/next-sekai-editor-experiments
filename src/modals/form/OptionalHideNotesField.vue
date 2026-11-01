<script setup lang="ts">
import { i18n } from '../../i18n'
import OptionalToggleField from './OptionalToggleField.vue'
import { usePropertyDescription } from './propertyDescription'

const modelValue = defineModel<boolean | undefined>({ required: true })
const description = usePropertyDescription((t) => t.modals.form.descriptions.hideNotes)
</script>

<template>
    <OptionalToggleField
        v-model="modelValue"
        :description
        :label="i18n.modals.form.hideNotes.label"
    />
</template>
