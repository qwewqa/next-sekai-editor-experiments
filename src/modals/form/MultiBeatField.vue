<script setup lang="ts">
import { computed } from 'vue'
import { i18n } from '../../i18n'
import { fromFieldBeat, fromSteppedBeat, toFieldBeat } from './beatField'
import MultiNumberField from './MultiNumberField.vue'

const modelValue = defineModel<number | undefined>({ required: true })
const displayedBeat = computed({
    get: () => (modelValue.value === undefined ? undefined : toFieldBeat(modelValue.value)),
    set: (value: number | undefined) => {
        modelValue.value = value === undefined ? undefined : fromFieldBeat(value)
    },
})
const setStep = (value: number) => {
    modelValue.value = fromSteppedBeat(value)
}
</script>

<template>
    <MultiNumberField
        v-model="displayedBeat"
        :label="i18n.modals.form.beat.label"
        :min="1"
        step="any"
        :set-step
    />
</template>
