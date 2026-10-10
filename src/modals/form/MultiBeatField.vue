<script setup lang="ts">
import { computed } from 'vue'
import { fromDisplayedBeat, toDisplayedBeat } from '../../editor/beatDisplay'
import { i18n } from '../../i18n'
import MultiNumberField from './MultiNumberField.vue'
import { alignFraction } from './numberStep'

const modelValue = defineModel<number | undefined>({ required: true })
const displayedBeat = computed({
    get: () => (modelValue.value === undefined ? undefined : toDisplayedBeat(modelValue.value)),
    set: (value: number | undefined) => {
        modelValue.value = value === undefined ? undefined : fromDisplayedBeat(value)
    },
})
// A beat stepped in displayed space lands an ulp off its grid; same-beat objects must be equal.
const setStep = (value: number) => {
    modelValue.value = alignFraction(fromDisplayedBeat(value))
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
