<script setup lang="ts">
import { inject } from 'vue'
import { i18n } from '../../i18n'
import BaseField from '../../modals/form/BaseField.vue'
import NumberField from '../../modals/form/NumberField.vue'
import SelectField from '../../modals/form/SelectField.vue'
import ToggleField from '../../modals/form/ToggleField.vue'
import { previewAspectRatios, previewNoteSpeed, previewRenderScale } from '../../preview/options'
import { previewControlOptions, previewTransportOptions } from '../../preview/settingsOptions'
import { settings } from '../../settings'
import { showPreviewAssets } from '../commands/previewAssets/modal'
import { closeSettingsKey } from './closeSettings'
import SettingsSection from './SettingsSection.vue'

// Same order and labels as the preview's own settings form. Placement is under Panels.
const closeSettings = inject(closeSettingsKey, undefined)
const openAssets = () => {
    closeSettings?.()
    void showPreviewAssets()
}
</script>

<template>
    <SettingsSection id="preview" :title="i18n.settings.preview.title">
        <!-- Choosing the skin and the rest has a dialog of its own. -->
        <BaseField
            :label="i18n.settings.preview.assets"
            :notes="[i18n.settings.preview.assetsHint]"
        >
            <input
                class="btn btn-secondary h-9 max-w-full rounded-full px-4"
                type="button"
                data-settings-assets
                :value="i18n.commands.previewAssets.title"
                @click="openAssets"
            />
        </BaseField>
        <NumberField
            v-model="settings.previewNoteSpeed"
            :label="i18n.settings.preview.noteSpeed"
            :min="previewNoteSpeed.min"
            :max="previewNoteSpeed.max"
            :step="previewNoteSpeed.step"
        />
        <ToggleField
            v-model="settings.previewHighlightSelection"
            :label="i18n.settings.preview.highlightSelection"
        />
        <ToggleField
            v-model="settings.previewShowHitboxes"
            :label="i18n.settings.preview.showHitboxes"
        />
        <ToggleField
            v-model="settings.previewShowEffects"
            :label="i18n.settings.preview.showEffects"
        />
        <ToggleField v-model="settings.previewShowTime" :label="i18n.settings.preview.showTime" />
        <SelectField
            v-model="settings.previewAspectRatio"
            :label="i18n.settings.preview.aspectRatio"
            :options="previewAspectRatios"
        />
        <NumberField
            v-model="settings.previewRenderScale"
            :label="i18n.settings.preview.renderScale"
            :min="previewRenderScale.min"
            :max="previewRenderScale.max"
            :step="previewRenderScale.step"
        />
        <ToggleField v-model="settings.previewAntialias" :label="i18n.settings.preview.antialias" />
        <SelectField
            v-model="settings.previewTransportPosition"
            :label="i18n.settings.preview.transport.title"
            :options="previewTransportOptions"
        />
        <SelectField
            v-model="settings.previewControls"
            :label="i18n.settings.preview.controls.title"
            :options="previewControlOptions"
        />
    </SettingsSection>
</template>
