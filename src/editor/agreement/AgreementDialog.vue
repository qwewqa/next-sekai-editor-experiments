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
import LanguageField from '../settings/LanguageField.vue'
import ThemeField from '../settings/ThemeField.vue'
import UsageStatisticsField from '../settings/UsageStatisticsField.vue'
import AgreementSentence from './AgreementSentence.vue'

defineProps<{
    /** Which page changed since the stored agreement; none on a first agreement. */
    change?: 'terms' | 'privacy' | 'both'
}>()

const emit = defineEmits<{
    close: [result: 'agree']
}>()

const { appVersion: shown } = appVersion()

// Long values such as languages go below their label on phones, as in Settings.
provide(stackLongValuesKey, true)
</script>

<template>
    <BaseModal :title="PRODUCT_NAME" :closable="false">
        <div class="flex flex-col gap-1">
            <div v-if="change" class="text-fg-strong" data-modal-description data-agreement-change>
                {{ i18n.agreement.updated[change] }}
            </div>
            <div class="flex flex-col gap-1" data-agreement>
                <div>{{ interpolateRaw(i18n.settings.about.version, shown) }}</div>
                <div v-if="SITE === 'test'">{{ TEST_SITE_ABOUT }}</div>
            </div>
        </div>

        <div class="flex flex-col gap-3">
            <LanguageField />
            <ThemeField />
        </div>

        <UsageStatisticsField v-if="analyticsTarget" />

        <template #footer>
            <div class="flex w-full flex-wrap items-end justify-end gap-x-4 gap-y-3">
                <AgreementSentence
                    class="min-w-0 flex-[1_1_20rem] text-sm text-fg"
                    data-modal-description
                />
                <button
                    type="button"
                    class="btn btn-primary h-9 min-w-24 max-w-full shrink-0 truncate rounded-full px-4"
                    data-autofocus
                    @click="emit('close', 'agree')"
                >
                    {{ i18n.agreement.agree }}
                </button>
            </div>
        </template>
    </BaseModal>
</template>
