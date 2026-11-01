<script setup lang="ts">
import type { RotationCenter } from '../../chart/events/stage/transform'
import { i18n } from '../../i18n'
import ChoiceField from './ChoiceField.vue'
import { usePropertyDescription } from './propertyDescription'

const modelValue = defineModel<RotationCenter | undefined>({ required: true })
const description = usePropertyDescription((t) => t.modals.form.descriptions.rotationCenter)
</script>

<template>
    <ChoiceField
        v-model="modelValue"
        :description
        :label="i18n.modals.form.rotationCenter.label"
        :options="[
            [i18n.modals.form.rotationCenter.stage, 'stage'],
            [i18n.modals.form.rotationCenter.mask, 'mask'],
            [i18n.modals.form.rotationCenter.screen, 'screen'],
            [i18n.modals.form.rotationCenter.vanishingPoint, 'vanishingPoint'],
        ]"
        variant="optional"
    />
</template>
