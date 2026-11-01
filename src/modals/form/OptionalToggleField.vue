<script setup lang="ts">
import { i18n } from '../../i18n'
import { useUnsetChoice } from './emptyLabel'
import MultiToggleField from './MultiToggleField.vue'
import OptionalSelectField from './OptionalSelectField.vue'

defineProps<{
    label: string
    /** What the property does, behind an ⓘ after the label. */
    description?: string | null
}>()

const modelValue = defineModel<boolean | undefined>({ required: true })

// Without an unset choice, as in the brush, the value is always set: a toggle, as in Selection.
const unsetChoice = useUnsetChoice()
</script>

<template>
    <MultiToggleField v-if="!unsetChoice" v-model="modelValue" :label :description />
    <OptionalSelectField
        v-else
        v-model="modelValue"
        :label
        :description
        :options="[
            [i18n.modals.form.toggle.disabled, false],
            [i18n.modals.form.toggle.enabled, true],
        ]"
    />
</template>
