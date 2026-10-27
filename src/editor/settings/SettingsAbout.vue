<script setup lang="ts">
import { computed } from 'vue'
import { analyticsTarget } from '../../analytics/start'
import { SITE, TEST_SITE_ABOUT } from '../../buildInfo'
import { i18n } from '../../i18n'
import { showModal } from '../../modals'
import { appVersion } from '../../platform'
import { PRODUCT_NAME } from '../../product'
import { interpolateRaw } from '../../utils/interpolate'
import AboutLinks, { aboutButtonClass } from './AboutLinks.vue'
import { collectDiagnosticText } from './diagnosticInfo'
import DiagnosticsModal from './DiagnosticsModal.vue'
import SettingsSection from './SettingsSection.vue'
import UsageStatisticsField from './UsageStatisticsField.vue'

const about = computed(() => i18n.value.settings.about)

const { appVersion: shown } = appVersion()

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

        <!-- Only in a build that has somewhere to send them. -->
        <UsageStatisticsField v-if="analyticsTarget" data-about-usage-statistics />

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
