<script setup lang="ts">
import type { ConnectorPresentation } from '../../chart/note'
import { i18n } from '../../i18n'
import ChoiceField from './ChoiceField.vue'
import { usePropertyDescription } from './propertyDescription'

const modelValue = defineModel<ConnectorPresentation | undefined>({ required: true })
const description = usePropertyDescription(
    (t) => t.modals.form.descriptions.connectorPresentation.intro,
)
</script>

<template>
    <ChoiceField
        v-model="modelValue"
        :description
        :label="i18n.modals.form.connectorPresentation.label"
        :options="[
            [i18n.modals.form.connectorPresentation.default, 'default'],
            [i18n.modals.form.connectorPresentation.fullscreen, 'fullscreen'],
        ]"
        variant="multi"
    />
</template>
