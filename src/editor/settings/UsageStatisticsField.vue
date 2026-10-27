<script setup lang="ts">
import { computed } from 'vue'
import { browserSignalSet } from '../../analytics/start'
import { preference } from '../../analytics/config'
import { i18n } from '../../i18n'
import ToggleField from '../../modals/form/ToggleField.vue'
import { settings } from '../../settings'

// Send Usage Statistics with its note, in Settings › About and in the agreement dialog. It shows
// the user's choice, else off where the browser sends Do Not Track or Global Privacy Control.
// The caller shows it only in a build that has somewhere to send them.

const about = computed(() => i18n.value.settings.about)

const usageStatistics = computed({
    get: () => preference(settings.usageStatistics, browserSignalSet),
    set: (value: boolean) => (settings.usageStatistics = value),
})
const note = computed(() =>
    settings.usageStatistics === null && browserSignalSet
        ? about.value.usageStatisticsSignal
        : about.value.usageStatisticsNote,
)
</script>

<template>
    <ToggleField v-model="usageStatistics" :label="about.usageStatistics" :notes="[note]" />
</template>
