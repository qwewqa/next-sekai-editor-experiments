<script setup lang="ts">
import type { TimeScaleEase } from '../../chart/timeScale'
import { timeScaleEaseFunctionNames, type EaseEdit } from '../../ease'
import { i18n } from '../../i18n'
import EaseField from './EaseField.vue'
import { usePropertyDescription } from './propertyDescription'

const modelValue = defineModel<EaseEdit<TimeScaleEase> | undefined>({ required: true })
const typeDescription = usePropertyDescription((t) => t.modals.form.descriptions.timeScaleEase)
</script>

<template>
    <EaseField
        v-model="modelValue"
        :type-description="typeDescription"
        :type-label="i18n.modals.form.timeScaleEase.type"
        :function-label="i18n.modals.form.timeScaleEase.function"
        :functions="timeScaleEaseFunctionNames"
    />
</template>
