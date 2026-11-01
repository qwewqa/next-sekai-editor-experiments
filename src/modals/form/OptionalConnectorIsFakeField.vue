<script setup lang="ts">
import { i18n } from '../../i18n/index.ts'
import OptionalToggleField from './OptionalToggleField.vue'
import { usePropertyDescription } from './propertyDescription'

const modelValue = defineModel<boolean | undefined>({ required: true })
const description = usePropertyDescription((t) => t.modals.form.descriptions.connectorIsFake)
</script>

<template>
    <OptionalToggleField
        v-model="modelValue"
        :description
        :label="i18n.modals.form.connectorIsFake.label"
    />
</template>
