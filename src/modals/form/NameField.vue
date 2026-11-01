<script setup lang="ts">
import { i18n } from '../../i18n'
import { usePropertyDescription } from './propertyDescription'
import { textLimits } from './textLimits'
import TextField from './TextField.vue'

const modelValue = defineModel<string>({ required: true })
const description = usePropertyDescription((t) => t.modals.form.descriptions.name)
</script>

<template>
    <TextField
        v-model="modelValue"
        :label="i18n.modals.form.name.label"
        :description
        :maxlength="textLimits.name"
    />
</template>
