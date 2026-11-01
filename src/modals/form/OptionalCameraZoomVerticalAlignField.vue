<script setup lang="ts">
import type { CameraZoomVerticalAlign } from '../../chart/events/camera'
import { i18n } from '../../i18n'
import ChoiceField from './ChoiceField.vue'
import { usePropertyDescription } from './propertyDescription'

const modelValue = defineModel<CameraZoomVerticalAlign | undefined>({ required: true })
const description = usePropertyDescription(
    (t) => t.modals.form.descriptions.cameraZoomVerticalAlign,
)
</script>

<template>
    <ChoiceField
        v-model="modelValue"
        :description
        :label="i18n.modals.form.cameraZoomVerticalAlign.label"
        :options="[
            [i18n.modals.form.cameraZoomVerticalAlign.default, 'default'],
            [i18n.modals.form.cameraZoomVerticalAlign.center, 'center'],
        ]"
        variant="optional"
    />
</template>
