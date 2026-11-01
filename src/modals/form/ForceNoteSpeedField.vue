<script setup lang="ts">
import { i18n } from '../../i18n'
import OptionalNumberField from './OptionalNumberField.vue'
import { usePropertyDescription } from './propertyDescription'

const modelValue = defineModel<number | undefined>({ required: true })
const description = usePropertyDescription((t) => t.modals.form.descriptions.forceNoteSpeed)
</script>

<template>
    <OptionalNumberField
        v-model="modelValue"
        :label="i18n.commands.manageGroups.modal.properties.modal.forceNoteSpeed"
        :description
        :min="1"
        :max="12"
        step="any"
    />
</template>
