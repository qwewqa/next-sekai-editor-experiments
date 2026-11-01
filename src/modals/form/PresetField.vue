<script setup lang="ts">
import { i18n } from '../../i18n'
import { usePropertyDescription } from './propertyDescription'
import SelectField from './SelectField.vue'

defineProps<{
    count: number
}>()

const modelValue = defineModel<number>({ required: true })
const description = usePropertyDescription((t) => t.modals.form.descriptions.preset)
</script>

<template>
    <SelectField
        v-model="modelValue"
        :label="i18n.modals.form.preset.label"
        :description
        :options="[...Array(count).keys()].map((i) => [`${i + 1}`, i])"
    />
</template>
