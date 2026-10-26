<script setup lang="ts">
import { maxLane } from '../../chart/limits'
import { i18n } from '../../i18n'
import MultiNumberField from './MultiNumberField.vue'

const modelValue = defineModel<number | undefined>({ required: true })
</script>

<template>
    <MultiNumberField
        v-model="modelValue"
        :label="i18n.modals.form.maskLeft.label"
        :min="-maxLane"
        :max="maxLane"
        step="any"
    />
</template>
