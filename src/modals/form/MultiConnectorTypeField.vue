<script setup lang="ts">
import type { ConnectorType } from '../../chart/note.ts'
import { i18n } from '../../i18n'
import MultiSelectField from './MultiSelectField.vue'
import { usePropertyDescription } from './propertyDescription'

const modelValue = defineModel<ConnectorType | undefined>({ required: true })
const description = usePropertyDescription((t) => t.modals.form.descriptions.connectorType.intro)
</script>

<template>
    <MultiSelectField
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
