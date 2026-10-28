<script setup lang="ts">
import { i18n } from '../../i18n'
import SelectField from '../../modals/form/SelectField.vue'
import { panelPositionOptions } from '../../preview/settingsOptions'
import { settings } from '../../settings'
import { getPanelPosition, setPanelPosition } from '../workspace'
import { panelIds, sideBySideChoices } from '../workspace/layout'
import { panelTitle } from '../workspace/panels'
import SettingsSection from './SettingsSection.vue'
</script>

<template>
    <SettingsSection id="panels" :title="i18n.settings.panels.title">
        <SelectField
            v-for="id in panelIds"
            :key="id"
            :model-value="getPanelPosition(id)"
            :label="panelTitle(id)"
            :options="panelPositionOptions"
            @update:model-value="setPanelPosition(id, $event)"
        />

        <SelectField
            v-model="settings.groupsStagesSideBySide"
            :label="i18n.settings.panels.groupsStagesSideBySide.title"
            :description="i18n.settings.descriptions.groupsStagesSideBySide"
            :options="
                sideBySideChoices.map((choice) => [
                    i18n.settings.panels.groupsStagesSideBySide[choice],
                    choice,
                ])
            "
        />
    </SettingsSection>
</template>
