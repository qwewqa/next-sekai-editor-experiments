<script setup lang="ts">
import { computed, watch } from 'vue'
import { bgm } from '../../history/bgm'
import { i18n } from '../../i18n'
import { showModal } from '../../modals'
import NumberField from '../../modals/form/NumberField.vue'
import SelectField from '../../modals/form/SelectField.vue'
import ToggleField from '../../modals/form/ToggleField.vue'
import InfoModal from '../../modals/InfoModal.vue'
import { settings } from '../../settings'
import { isMinimapShown } from '../workspace'
import LanguageField from './LanguageField.vue'
import SettingsSection from './SettingsSection.vue'
import ThemeField from './ThemeField.vue'

// Reads the shown state, which a null setting resolves by width, and saves a choice.
const showMinimap = computed({
    get: () => isMinimapShown.value,
    set: (value) => {
        settings.showMinimap = value
    },
})

watch(
    () => settings.waveform,
    (waveform) => {
        if (waveform === 'off') return
        if (!bgm.value.buffer) return

        void showModal(InfoModal, {
            title: () => i18n.value.settings.editor.waveformVisualization.title,
            message: () => i18n.value.settings.editor.waveformVisualization.changed,
        })
    },
)
</script>

<template>
    <SettingsSection id="editor" :title="i18n.settings.editor.title">
        <LanguageField />

        <ThemeField />

        <SelectField
            v-model="settings.beatDisplay"
            :label="i18n.settings.editor.beatDisplay.title"
            :description="i18n.settings.descriptions.beatDisplay"
            :options="[
                [i18n.settings.editor.beatDisplay.beat, 'beat'],
                [i18n.settings.editor.beatDisplay.measure, 'measure'],
                [i18n.settings.editor.beatDisplay.both, 'both'],
            ]"
        />

        <SelectField
            v-model="settings.waveform"
            :label="i18n.settings.editor.waveformVisualization.title"
            :description="i18n.settings.descriptions.waveform"
            :options="[
                [i18n.settings.editor.waveformVisualization.volume, 'volume'],
                [i18n.settings.editor.waveformVisualization.fft, 'fft'],
                [i18n.settings.editor.waveformVisualization.off, 'off'],
            ]"
        />

        <SelectField
            v-model="settings.zeroWidthNotes"
            :label="i18n.settings.editor.zeroWidthNotes.title"
            :description="i18n.settings.descriptions.zeroWidthNotes"
            :options="[
                [i18n.settings.editor.zeroWidthNotes.off, 'off'],
                [i18n.settings.editor.zeroWidthNotes.anchors, 'anchors'],
                [i18n.settings.editor.zeroWidthNotes.all, 'all'],
            ]"
        />

        <ToggleField v-model="showMinimap" :label="i18n.settings.editor.minimap" />

        <ToggleField
            v-model="settings.dimUnchangedObjects"
            :label="i18n.settings.editor.dimUnchangedObjects"
            :description="i18n.settings.descriptions.dimUnchangedObjects"
        />

        <ToggleField
            v-model="settings.showGroupName"
            :label="i18n.settings.editor.showGroupName"
            :description="i18n.settings.descriptions.showGroupName"
        />

        <ToggleField
            v-model="settings.hideGroupNameWhenFocusingGroup"
            :label="i18n.settings.editor.hideGroupNameWhenFocusingGroup"
        />

        <ToggleField
            v-model="settings.showOtherGroups"
            :label="i18n.settings.editor.showOtherGroups"
            :description="i18n.settings.descriptions.showOtherGroups"
        />

        <ToggleField
            v-model="settings.showStageName"
            :label="i18n.settings.editor.showStageName"
            :description="i18n.settings.descriptions.showStageName"
        />

        <ToggleField
            v-model="settings.hideStageNameWhenFocusingStage"
            :label="i18n.settings.editor.hideStageNameWhenFocusingStage"
        />

        <ToggleField
            v-model="settings.showOtherStages"
            :label="i18n.settings.editor.showOtherStages"
            :description="i18n.settings.descriptions.showOtherStages"
        />

        <ToggleField
            v-model="settings.showOtherObjects"
            :label="i18n.settings.editor.showOtherObjects"
            :description="i18n.settings.descriptions.showOtherObjects"
        />

        <ToggleField
            v-model="settings.nameContrast"
            :label="i18n.settings.editor.nameContrast"
            :description="i18n.settings.descriptions.nameContrast"
        />

        <NumberField
            v-model="settings.maxScrollX"
            :label="i18n.settings.editor.maxScrollX"
            :description="i18n.settings.descriptions.maxScrollX"
            :min="0"
        />

        <ToggleField
            v-model="settings.dragToPanY"
            :label="i18n.settings.editor.dragToPanY"
            :description="i18n.settings.descriptions.dragToPanY"
        />

        <ToggleField
            v-model="settings.dragToPanX"
            :label="i18n.settings.editor.dragToPanX"
            :description="i18n.settings.descriptions.dragToPanX"
        />

        <ToggleField
            v-model="settings.deselectSwitchesToSelect"
            :label="i18n.settings.editor.deselectSwitchesToSelect"
        />

        <SelectField
            v-model="settings.elevationEditorSideBySide"
            :label="i18n.settings.editor.elevationSideBySide"
            :description="i18n.settings.descriptions.elevationEditorSideBySide"
            :options="[
                [i18n.elevation.auto, 'auto'],
                [i18n.elevation.always, 'allow'],
                [i18n.elevation.never, 'disallow'],
            ]"
        />

        <ToggleField
            v-model="settings.elevationConnectorArrows"
            :label="i18n.settings.editor.elevationConnectorArrows"
            :description="i18n.settings.descriptions.elevationConnectorArrows"
        />
    </SettingsSection>
</template>
