<script setup lang="ts">
import type { ConnectorType } from '../../chart/note.ts'
import { i18n } from '../../i18n'
import OptionalSelectField from './OptionalSelectField.vue'
import { usePropertyDescription } from './propertyDescription'

const modelValue = defineModel<ConnectorType | undefined>({ required: true })
const description = usePropertyDescription((t) => t.modals.form.descriptions.connectorType)
</script>

<template>
    <OptionalSelectField
        v-model="modelValue"
        :description
        :label="i18n.modals.form.connectorType.label"
        :options="[
            [i18n.modals.form.connectorType.active, 'active'],
            [i18n.modals.form.connectorType.guide, 'guide'],
            [i18n.modals.form.connectorType.damage, 'damage'],
        ]"
    />
</template>
