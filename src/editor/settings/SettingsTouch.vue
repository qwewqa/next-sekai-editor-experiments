<script setup lang="ts">
import { i18n } from '../../i18n'
import NumberField from '../../modals/form/NumberField.vue'
import SelectField from '../../modals/form/SelectField.vue'
import ToggleField from '../../modals/form/ToggleField.vue'
import { settings } from '../../settings'
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

        <SelectField
            v-model="settings.touchQuickScrollShow"
            :label="i18n.settings.touch.showQuickScroll.title"
            :options="[
                [i18n.settings.touch.showQuickScroll.on, 'on'],
                [i18n.settings.touch.showQuickScroll.off, 'off'],
                [i18n.settings.touch.showQuickScroll.touch, 'touch'],
            ]"
        />

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
