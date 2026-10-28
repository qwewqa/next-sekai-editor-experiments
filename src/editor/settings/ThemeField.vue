<script setup lang="ts">
import { i18n } from '../../i18n'
import SelectField from '../../modals/form/SelectField.vue'
import { settings } from '../../settings'
import { themes } from '../../themes'

// Theme, in Settings and in the agreement dialog.
</script>

<template>
    <SelectField
        v-model="settings.theme"
        :label="i18n.settings.editor.theme.title"
        :options="
            (['system', ...themes] as const).map((theme) => [
                i18n.settings.editor.theme[theme],
                theme,
            ])
        "
    />
</template>
