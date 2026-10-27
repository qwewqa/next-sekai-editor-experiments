<script setup lang="ts">
import { i18n } from '../../i18n'
import NumberField from '../../modals/form/NumberField.vue'
import ToggleField from '../../modals/form/ToggleField.vue'
import { settings } from '../../settings'
import QuickScrollShowField from './QuickScrollShowField.vue'
import SettingsSection from './SettingsSection.vue'
</script>

<template>
    <SettingsSection id="touch" :title="i18n.settings.touch.title">
        <NumberField
            v-model="settings.touchQuickScrollWidth"
            :label="i18n.settings.touch.quickScrollWidth"
            :min="0"
            :max="200"
            step="any"
        />

        <QuickScrollShowField />

        <ToggleField
            v-model="settings.touchScrollInertia"
            :label="i18n.settings.touch.scrollInertia"
        />

        <ToggleField
            v-model="settings.touchLongPressContextMenu"
            :label="i18n.settings.touch.longPressContextMenu"
        />
    </SettingsSection>
</template>
