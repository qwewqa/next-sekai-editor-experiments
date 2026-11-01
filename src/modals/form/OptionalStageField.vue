<script setup lang="ts">
import type { StageId } from '../../chart/stages'
import { folderSections } from '../../chart/folders'
import { stageFolders, stages } from '../../history/stages'
import { i18n } from '../../i18n'
import OptionalSelectField from './OptionalSelectField.vue'
import { usePropertyDescription } from './propertyDescription'

defineProps<{
    /** Replaces the field's label, e.g. where it picks the current stage. */
    label?: string
    /** Text for no stage, e.g. when it means every stage rather than 'unchanged'. */
    emptyLabel?: string
}>()

const modelValue = defineModel<StageId | undefined>({ required: true })
const description = usePropertyDescription((t) => t.modals.form.descriptions.stageId)
</script>

<template>
    <OptionalSelectField
        v-model="modelValue"
        :description
        :empty-label
        :label="label ?? i18n.modals.form.stage.label"
        :sections="folderSections(stages, stageFolders)"
    />
</template>
