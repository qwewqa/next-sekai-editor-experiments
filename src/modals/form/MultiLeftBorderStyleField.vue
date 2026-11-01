<script setup lang="ts">
import type { BorderStyle } from '../../chart/events/stage/style'
import { i18n } from '../../i18n'
import MultiBorderStyleField from './MultiBorderStyleField.vue'
import { usePropertyDescription } from './propertyDescription'

const modelValue = defineModel<BorderStyle | undefined>({ required: true })
const description = usePropertyDescription((t) => t.modals.form.descriptions.borderStyle)
</script>

<template>
    <MultiBorderStyleField
        v-model="modelValue"
        :description
        :label="i18n.modals.form.leftBorderStyle.label"
    />
</template>
