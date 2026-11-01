<script setup lang="ts">
import type { BorderStyle } from '../../chart/events/stage/style'
import { i18n } from '../../i18n'
import OptionalBorderStyleField from './OptionalBorderStyleField.vue'
import { usePropertyDescription } from './propertyDescription'

const modelValue = defineModel<BorderStyle | undefined>({ required: true })
const description = usePropertyDescription((t) => t.modals.form.descriptions.rightBorderStyle)
</script>

<template>
    <OptionalBorderStyleField
        v-model="modelValue"
        :description
        :label="i18n.modals.form.rightBorderStyle.label"
    />
</template>
