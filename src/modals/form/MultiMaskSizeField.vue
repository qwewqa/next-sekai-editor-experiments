<script setup lang="ts">
import { maxSize } from '../../chart/limits'
import { i18n } from '../../i18n'
import MultiNumberField from './MultiNumberField.vue'
import { usePropertyDescription } from './propertyDescription'

const modelValue = defineModel<number | undefined>({ required: true })
const description = usePropertyDescription((t) => t.modals.form.descriptions.maskSize)
</script>

<template>
    <MultiNumberField
        v-model="modelValue"
        :description
        :label="i18n.modals.form.maskSize.label"
        :min="0"
        :max="maxSize"
        step="any"
    />
</template>
