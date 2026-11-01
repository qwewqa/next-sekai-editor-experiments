<script setup lang="ts">
import type { JudgmentLineStyle } from '../../chart/events/stage/style'
import { i18n } from '../../i18n'
import ChoiceField from './ChoiceField.vue'
import { usePropertyDescription } from './propertyDescription'

const modelValue = defineModel<JudgmentLineStyle | undefined>({ required: true })
const description = usePropertyDescription((t) => t.modals.form.descriptions.judgmentLineStyle)
</script>

<template>
    <ChoiceField
        v-model="modelValue"
        :description
        :label="i18n.modals.form.judgmentLineStyle.label"
        :options="[
            [i18n.modals.form.judgmentLineStyle.default, 'default'],
            [i18n.modals.form.judgmentLineStyle.singleLine, 'singleLine'],
        ]"
        variant="optional"
    />
</template>
