<script setup lang="ts">
import type { GroupId } from '../../chart/groups'
import { folderSections } from '../../chart/folders'
import { groupFolders, groups } from '../../history/groups'
import { i18n } from '../../i18n'
import MultiSelectField from './MultiSelectField.vue'
import { usePropertyDescription } from './propertyDescription'

const modelValue = defineModel<GroupId | undefined>({ required: true })
const description = usePropertyDescription((t) => t.modals.form.descriptions.groupId)
</script>

<template>
    <MultiSelectField
        v-model="modelValue"
        :description
        :label="i18n.modals.form.group.label"
        :sections="folderSections(groups, groupFolders)"
    />
</template>
