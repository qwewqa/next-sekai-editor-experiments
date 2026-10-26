<script setup lang="ts">
import { maxSize } from '../../chart/limits'
import { i18n } from '../../i18n'
import OptionalNumberField from './OptionalNumberField.vue'

const modelValue = defineModel<number | undefined>({ required: true })
</script>

<template>
    <OptionalNumberField
        v-model="modelValue"
        :label="i18n.modals.form.size.label"
        :min="0"
        :max="maxSize"
        step="any"
    />
</template>
