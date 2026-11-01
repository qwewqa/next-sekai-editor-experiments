<script setup lang="ts">
import type { StageId } from '../../chart/stages'
import { folderSections } from '../../chart/folders'
import { stageFolders, stages } from '../../history/stages'
import { i18n } from '../../i18n'
import MultiSelectField from './MultiSelectField.vue'
import { usePropertyDescription } from './propertyDescription'

const modelValue = defineModel<StageId | undefined>({ required: true })
const description = usePropertyDescription((t) => t.modals.form.descriptions.stageId)
</script>

<template>
    <MultiSelectField
        v-model="modelValue"
        :description
        :label="i18n.modals.form.stage.label"
        :sections="folderSections(stages, stageFolders)"
    />
</template>
