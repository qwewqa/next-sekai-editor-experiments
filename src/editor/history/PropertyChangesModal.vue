<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { i18n } from '../../i18n'
import { formatDateTimeSeconds } from '../../i18n/when'
import BaseModal from '../../modals/BaseModal.vue'
import { interpolateRaw } from '../../utils/interpolate'
import ChevronIcon from '../workspace/ChevronIcon.vue'
import { closePropertyInspection, propertyInspection } from './changes'
import type { InspectionComparison } from './inspection'
import {
    PROPERTY_PAGE_SIZE,
    propertyPage,
    propertyRowKey,
    propertySectionKey,
} from './propertyChanges'
import {
    propertyCount,
    propertyFieldLabel,
    propertyReferenceText,
    propertySectionLabel,
} from './propertyPresentation'
import PropertyChangeValue from './PropertyChangeValue.vue'

const props = defineProps<{ comparison: InspectionComparison; summary: string }>()
const emit = defineEmits<{ close: [] }>()
const limit = ref(PROPERTY_PAGE_SIZE)
const inspection = computed(() =>
    propertyInspection.value?.comparison === props.comparison
        ? propertyInspection.value
        : undefined,
)
const page = computed(() =>
    inspection.value?.changes ? propertyPage(inspection.value.changes, limit.value) : undefined,
)
watch(
    inspection,
    (value) => {
        if (!value) emit('close')
    },
    { immediate: true, flush: 'sync' },
)
onBeforeUnmount(() => {
    if (propertyInspection.value?.comparison === props.comparison) closePropertyInspection()
})
</script>

<template>
    <BaseModal :title="i18n.historyChanges.title" @close="emit('close')">
        <div class="min-w-0 select-text space-y-1 [overflow-wrap:anywhere]" data-property-context>
            <p class="whitespace-pre-wrap font-bold">{{ comparison.request.label }}</p>
            <p class="text-sm text-fg/75">{{ formatDateTimeSeconds(comparison.request.time) }}</p>
            <p class="whitespace-pre-wrap text-sm">{{ summary }}</p>
        </div>
        <div class="min-h-24 min-w-0 text-sm" data-property-comparison>
            <p v-if="inspection?.status === 'loading' && inspection.delayed">
                {{ i18n.peek.loadingChanges }}
            </p>
            <p v-else-if="inspection?.status === 'unavailable'">{{ i18n.peek.unavailable }}</p>
            <div v-else-if="page" class="space-y-5">
                <section
                    v-for="section in page.sections"
                    :key="propertySectionKey(section)"
                    :data-property-section="propertySectionKey(section)"
                    class="min-w-0"
                >
                    <h3
                        class="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 font-bold [overflow-wrap:anywhere]"
                    >
                        <span>{{ propertySectionLabel(section.kind) }}</span>
                        <span v-if="section.beforeName" class="min-w-0 whitespace-pre-wrap">{{
                            propertyReferenceText(section.beforeName)
                        }}</span>
                        <ChevronIcon
                            v-if="
                                section.beforeName &&
                                section.afterName &&
                                propertyReferenceText(section.beforeName) !==
                                    propertyReferenceText(section.afterName)
                            "
                            direction="right"
                            class="size-3 shrink-0"
                        />
                        <span
                            v-if="
                                section.afterName &&
                                (!section.beforeName ||
                                    propertyReferenceText(section.beforeName) !==
                                        propertyReferenceText(section.afterName))
                            "
                            class="min-w-0 whitespace-pre-wrap"
                            >{{ propertyReferenceText(section.afterName) }}</span
                        >
                        <span
                            v-if="section.status"
                            class="rounded bg-header px-2 py-0.5 text-xs"
                            data-property-badge
                            >{{ i18n.historyChanges[section.status] }}</span
                        >
                    </h3>
                    <div
                        v-for="row in section.rows"
                        :key="propertyRowKey(section, row)"
                        :data-property-row="row.field"
                        class="min-w-0 border-t border-fg/15 py-3"
                    >
                        <h4 class="mb-2 font-bold">{{ propertyFieldLabel(row.field) }}</h4>
                        <div class="grid min-w-0 grid-cols-2 gap-3">
                            <div class="min-w-0" data-property-before>
                                <p class="mb-1 text-xs text-fg/75">
                                    {{ i18n.historyChanges.before }}
                                </p>
                                <PropertyChangeValue :value="row.before" :field="row.field" />
                            </div>
                            <div class="min-w-0" data-property-after>
                                <p class="mb-1 text-xs text-fg/75">
                                    {{ i18n.historyChanges.after }}
                                </p>
                                <PropertyChangeValue :value="row.after" :field="row.field" />
                            </div>
                        </div>
                    </div>
                </section>
                <div class="flex flex-wrap items-center justify-between gap-2" data-property-count>
                    <span>{{
                        interpolateRaw(
                            i18n.historyChanges.shown,
                            propertyCount(page.shown),
                            propertyCount(page.total),
                        )
                    }}</span>
                    <button
                        v-if="page.shown < page.total"
                        type="button"
                        class="rounded-full bg-button px-4 py-2 font-bold focus-visible:outline focus-visible:outline-2"
                        data-property-more
                        @click="limit += PROPERTY_PAGE_SIZE"
                    >
                        {{ i18n.historyChanges.showMore }}
                    </button>
                </div>
            </div>
        </div>
    </BaseModal>
</template>
