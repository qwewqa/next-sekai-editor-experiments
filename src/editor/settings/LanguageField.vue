<script setup lang="ts">
import { i18n } from '../../i18n'
import { localizations } from '../../i18n/localizations'
import SelectField from '../../modals/form/SelectField.vue'
import { settings } from '../../settings'

// Language, in Settings and in the first-visit dialog; each language is named in itself.
</script>

<template>
    <SelectField
        v-model="settings.locale"
        :label="i18n.settings.editor.locale"
        :options="Object.entries(localizations).map(([locale, { title }]) => [title, locale])"
    />
</template>
