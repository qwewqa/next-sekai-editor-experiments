<script setup lang="ts">
import { i18n } from '../../i18n'
import { textLimits } from './textLimits'
import TextField from './TextField.vue'

const modelValue = defineModel<string>({ required: true })
</script>

<template>
    <TextField
        v-model="modelValue"
        :label="i18n.modals.form.name.label"
        :maxlength="textLimits.name"
    />
</template>
