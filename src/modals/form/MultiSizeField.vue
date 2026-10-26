<script setup lang="ts">
import { maxSize } from '../../chart/limits'
import { i18n } from '../../i18n'
import MultiNumberField from './MultiNumberField.vue'

const modelValue = defineModel<number | undefined>({ required: true })
</script>

<template>
    <MultiNumberField
        v-model="modelValue"
        :label="i18n.modals.form.size.label"
        :min="0"
        :max="maxSize"
        step="any"
    />
</template>
