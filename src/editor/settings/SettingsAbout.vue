<script setup lang="ts">
import { computed } from 'vue'
import { analyticsTarget, browserSignalSet } from '../../analytics/start'
import { preference } from '../../analytics/config'
import { SITE, TEST_SITE_ABOUT } from '../../buildInfo'
import { i18n } from '../../i18n'
import { showModal } from '../../modals'
import ToggleField from '../../modals/form/ToggleField.vue'
import { appVersion } from '../../platform'
import { PRODUCT_NAME } from '../../product'
import { settings } from '../../settings'
import { interpolateRaw } from '../../utils/interpolate'
import AboutLinks, { aboutButtonClass } from './AboutLinks.vue'
import { collectDiagnosticText } from './diagnosticInfo'
import DiagnosticsModal from './DiagnosticsModal.vue'
import SettingsSection from './SettingsSection.vue'

const about = computed(() => i18n.value.settings.about)

const { appVersion: shown } = appVersion()

// Send Usage Statistics, only in a build that has somewhere to send them. It
// shows the user's choice, else off where the browser sends Do Not Track or Global Privacy Control.
const usageStatistics = computed({
    get: () => preference(settings.usageStatistics, browserSignalSet),
    set: (value: boolean) => (settings.usageStatistics = value),
})
const usageStatisticsNote = computed(() =>
    settings.usageStatistics === null && browserSignalSet
        ? about.value.usageStatisticsSignal
        : about.value.usageStatisticsNote,
)

const diagnostics = async () => {
    await showModal(DiagnosticsModal, { text: await collectDiagnosticText() })
}
</script>

<template>
    <SettingsSection id="about" :title="about.title">
        <div class="flex flex-col gap-1">
            <div class="font-medium" data-about-name>{{ PRODUCT_NAME }}</div>
            <div data-about-version>{{ interpolateRaw(about.version, shown) }}</div>
        </div>

        <ToggleField
            v-if="analyticsTarget"
            v-model="usageStatistics"
            :label="about.usageStatistics"
            :notes="[usageStatisticsNote]"
            data-about-usage-statistics
        />

        <AboutLinks />

        <div class="flex">
            <button
                type="button"
                data-about-diagnostics
                :class="aboutButtonClass"
                @click="diagnostics"
            >
                <span class="truncate">{{ about.diagnostics }}</span>
            </button>
        </div>

        <div v-if="SITE === 'test'" data-about-test-site>{{ TEST_SITE_ABOUT }}</div>
    </SettingsSection>
</template>
