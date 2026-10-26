<script setup lang="ts">
import { maxLane } from '../../chart/limits'
import { i18n } from '../../i18n'
import OptionalNumberField from './OptionalNumberField.vue'

const modelValue = defineModel<number | undefined>({ required: true })
</script>

<template>
    <OptionalNumberField
        v-model="modelValue"
        :label="i18n.modals.form.cameraZoomTargetLane.label"
        :min="-maxLane"
        :max="maxLane"
        step="any"
    />
</template>
