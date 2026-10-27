<script setup lang="ts">
import { i18n } from '../../i18n'
import SelectField from '../../modals/form/SelectField.vue'
import { settings } from '../../settings'

// Show Quick Scroll Zone, in Settings and in the first-visit dialog; its description is Help's.
</script>

<template>
    <SelectField
        v-model="settings.touchQuickScrollShow"
        :label="i18n.settings.touch.showQuickScroll.title"
        :description="i18n.help.modal.touchscreen.quickScroll"
        :options="[
            [i18n.settings.touch.showQuickScroll.on, 'on'],
            [i18n.settings.touch.showQuickScroll.off, 'off'],
            [i18n.settings.touch.showQuickScroll.touch, 'touch'],
        ]"
    />
</template>
