<script setup lang="ts">
import { i18n } from '../../i18n'
import ToggleField from '../../modals/form/ToggleField.vue'
import { settings } from '../../settings'

// Show Property Descriptions, in Settings and in the agreement dialog.
</script>

<template>
    <ToggleField
        v-model="settings.showPropertyDescriptions"
        :label="i18n.settings.editor.showPropertyDescriptions"
        :description="i18n.settings.descriptions.showPropertyDescriptions"
    />
</template>
