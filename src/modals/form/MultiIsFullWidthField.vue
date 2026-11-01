<script setup lang="ts">
import { i18n } from '../../i18n'
import MultiToggleField from './MultiToggleField.vue'
import { usePropertyDescription } from './propertyDescription'

const modelValue = defineModel<boolean | undefined>({ required: true })
const description = usePropertyDescription((t) => t.modals.form.descriptions.isFullWidth)
</script>

<template>
    <MultiToggleField
        v-model="modelValue"
        :description
        :label="i18n.modals.form.isFullWidth.label"
    />
</template>
