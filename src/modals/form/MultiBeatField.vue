<script setup lang="ts">
import { computed } from 'vue'
import { maxBeat } from '../../chart/limits'
import { fromDisplayedBeat, toDisplayedBeat } from '../../editor/beatDisplay'
import { committedBarGrid, committedGrid } from '../../editor/beatGrid'
import { view } from '../../editor/view'
import { i18n } from '../../i18n'
import { fromSteppedBeat } from './beatField'
import MultiNumberField from './MultiNumberField.vue'

const modelValue = defineModel<number | undefined>({ required: true })
const displayedBeat = computed({
    get: () => (modelValue.value === undefined ? undefined : toDisplayedBeat(modelValue.value)),
    set: (value: number | undefined) => {
        modelValue.value = value === undefined ? undefined : fromDisplayedBeat(value)
    },
})
// As moved beats: onto the grid's line, or the chart's bar line other content may sit on.
const setStep = (value: number) => {
    modelValue.value = fromSteppedBeat(
        value,
        [committedGrid.value, committedBarGrid.value],
        view.division,
    )
}
</script>

<template>
    <MultiNumberField
        v-model="displayedBeat"
        :label="i18n.modals.form.beat.label"
        :min="1"
        :max="maxBeat + 1"
        step="any"
        :set-step
    />
</template>
