<script setup lang="ts">
import { i18n } from '../../i18n'
import NumberField from './NumberField.vue'
import { usePropertyDescription } from './propertyDescription'

const modelValue = defineModel<number>({ required: true })
const description = usePropertyDescription((t) => t.modals.form.descriptions.initialLife)
</script>

<template>
    <NumberField
        v-model="modelValue"
        :label="i18n.commands.properties.modal.life"
        :description
        :min="1"
        :step="1"
    />
</template>
