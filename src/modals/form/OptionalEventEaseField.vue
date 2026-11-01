<script setup lang="ts">
import { easeFunctionNames, type EaseEdit } from '../../ease'
import { i18n } from '../../i18n'
import EaseField from './EaseField.vue'
import { usePropertyDescription } from './propertyDescription'

const modelValue = defineModel<EaseEdit | undefined>({ required: true })
const typeDescription = usePropertyDescription((t) => t.modals.form.descriptions.eventEase)
</script>

<template>
    <EaseField
        v-model="modelValue"
        :type-description="typeDescription"
        :type-label="i18n.modals.form.eventEase.type"
        :function-label="i18n.modals.form.eventEase.function"
        :functions="easeFunctionNames"
        optional
    />
</template>
