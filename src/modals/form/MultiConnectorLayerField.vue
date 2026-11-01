<script setup lang="ts">
import type { ConnectorLayer } from '../../chart/note'
import { i18n } from '../../i18n'
import MultiSelectField from './MultiSelectField.vue'
import { usePropertyDescription } from './propertyDescription'

const modelValue = defineModel<ConnectorLayer | undefined>({ required: true })
const description = usePropertyDescription((t) => t.modals.form.descriptions.connectorLayer)
</script>

<template>
    <MultiSelectField
        v-model="modelValue"
        :description
        :label="i18n.modals.form.connectorLayer.label"
        :options="[
            [i18n.modals.form.connectorLayer.top, 'top'],
            [i18n.modals.form.connectorLayer.bottom, 'bottom'],
            [i18n.modals.form.connectorLayer.under, 'under'],
            [i18n.modals.form.connectorLayer.over, 'over'],
        ]"
    />
</template>
