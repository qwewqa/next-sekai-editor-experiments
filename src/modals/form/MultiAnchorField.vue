<script setup lang="ts">
import type { Anchor } from '../../chart/events/stage/transform'
import { i18n } from '../../i18n'
import ChoiceField from './ChoiceField.vue'
import { usePropertyDescription } from './propertyDescription'

const modelValue = defineModel<Anchor | undefined>({ required: true })
const description = usePropertyDescription((t) => t.modals.form.descriptions.anchor)
</script>

<template>
    <ChoiceField
        v-model="modelValue"
        :description
        :label="i18n.modals.form.anchor.label"
        :options="[
            [i18n.modals.form.anchor.default, 'default'],
            [i18n.modals.form.anchor.center, 'center'],
        ]"
        variant="multi"
    />
</template>
