<script setup lang="ts">
import { provide } from 'vue'
import { analyticsTarget } from '../../analytics/start'
import { SITE, TEST_SITE_ABOUT } from '../../buildInfo'
import { i18n } from '../../i18n'
import BaseModal from '../../modals/BaseModal.vue'
import { stackLongValuesKey } from '../../modals/form/fieldLayout'
import { appVersion } from '../../platform'
import { PRODUCT_NAME } from '../../product'
import { interpolateRaw } from '../../utils/interpolate'
import AboutLinks from '../settings/AboutLinks.vue'
import LanguageField from '../settings/LanguageField.vue'
import ThemeField from '../settings/ThemeField.vue'
import UsageStatisticsField from '../settings/UsageStatisticsField.vue'

const emit = defineEmits<{
    close: []
}>()

const { appVersion: shown } = appVersion()

// Long values such as languages go below their label on phones, as in Settings.
provide(stackLongValuesKey, true)
</script>

<template>
    <BaseModal :title="PRODUCT_NAME" @close="emit('close')">
        <div class="flex flex-col gap-1" data-first-visit>
            <div data-modal-description>
                {{ interpolateRaw(i18n.settings.about.version, shown) }}
            </div>
            <div v-if="SITE === 'test'">{{ TEST_SITE_ABOUT }}</div>
        </div>

        <div class="flex flex-col gap-3">
            <LanguageField />
            <ThemeField />
        </div>

        <div class="flex flex-col gap-3">
            <UsageStatisticsField v-if="analyticsTarget" data-modal-description />
            <AboutLinks :only="['privacy']" />
        </div>

        <template #footer>
            <button
                type="button"
                class="btn btn-primary h-9 min-w-24 max-w-full truncate rounded-full px-4"
                data-autofocus
                @click="emit('close')"
            >
                {{ i18n.modals.close }}
            </button>
        </template>
    </BaseModal>
</template>
