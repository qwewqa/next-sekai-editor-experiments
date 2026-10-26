<script setup lang="ts">
import { maxMeter } from '../../chart/limits'
import { i18n } from '../../i18n'
import MultiNumberField from './MultiNumberField.vue'

const modelValue = defineModel<number | undefined>({ required: true })
</script>

<template>
    <MultiNumberField
        v-model="modelValue"
        :label="i18n.modals.form.meter.label"
        :min="Number.EPSILON"
        :max="maxMeter"
        exclusive-min
        step="any"
    />
</template>
