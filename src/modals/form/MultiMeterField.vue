<script setup lang="ts">
import { maxMeter } from '../../chart/limits'
import { i18n } from '../../i18n'
import MultiNumberField from './MultiNumberField.vue'
import { usePropertyDescription } from './propertyDescription'

const modelValue = defineModel<number | undefined>({ required: true })
const description = usePropertyDescription((t) => t.modals.form.descriptions.meter)
</script>

<template>
    <MultiNumberField
        v-model="modelValue"
        :description
        :label="i18n.modals.form.meter.label"
        :min="Number.EPSILON"
        :max="maxMeter"
        exclusive-min
        step="any"
    />
</template>
