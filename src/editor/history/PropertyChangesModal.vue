<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { renderOperationRecipe } from '../../history/operationPresentation'
import { i18n } from '../../i18n'
import { settings } from '../../settings'
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
import DetailsHeader from './DetailsHeader.vue'
import PropertyChangeValue from './PropertyChangeValue.vue'
import { useHistoryCalendar } from './calendarClock'
import { historyFormat } from './historyFormat'
import { historyOperationContext } from './historyOperationContext'
import { peekedLabel } from './selection'

const props = defineProps<{ comparison: InspectionComparison; summary: string }>()
const emit = defineEmits<{ close: [] }>()
const limit = ref(PROPERTY_PAGE_SIZE)
// The step's title alone, as Step Details has it; its step count belongs to a list of steps.
const calendar = useHistoryCalendar()
const context = computed(() => historyOperationContext(calendar.value))
const title = computed(() => renderOperationRecipe(props.comparison.request.recipe, context.value))
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
// Revealing the rest removes the button, so focus moves to the first new row.
const showMore = async (event: Event) => {
    const root = (event.currentTarget as HTMLElement).closest('[data-property-comparison]')
    const first = root?.querySelectorAll('[data-property-row]').length ?? 0
    limit.value += PROPERTY_PAGE_SIZE
    await nextTick()
    if (root?.querySelector('[data-property-more]')) return
    ;(root?.querySelectorAll('[data-property-row]')[first] as HTMLElement | undefined)?.focus()
}
onBeforeUnmount(() => {
    if (propertyInspection.value?.comparison === props.comparison) closePropertyInspection()
})
</script>

<template>
    <BaseModal :title="i18n.historyChanges.title" @close="emit('close')">
        <DetailsHeader
            scope="property"
            class="select-text [overflow-wrap:anywhere]"
            :title="title"
            :meta="
                historyFormat(calendar, settings.locale).dateTimeSeconds(comparison.request.time)
            "
            :summary="
                summary !== title && summary !== peekedLabel(comparison.request, context)
                    ? summary
                    : undefined
            "
            data-property-context
        />
        <div class="min-h-24 min-w-0" data-property-comparison>
            <p v-if="inspection?.status === 'loading' && inspection.delayed">
                {{ i18n.peek.loadingChanges }}
            </p>
            <p v-else-if="inspection?.status === 'unavailable'">{{ i18n.peek.unavailable }}</p>
            <div v-else-if="page" class="space-y-4">
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
                            class="size-3 shrink-0 text-fg/70"
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
                            class="rounded-full bg-fg/[.08] px-2 py-0.5 text-xs font-normal"
                            data-property-badge
                            >{{ i18n.historyChanges[section.status] }}</span
                        >
                    </h3>
                    <div
                        v-for="row in section.rows"
                        :key="propertyRowKey(section, row)"
                        :data-property-row="row.field"
                        class="focus-edge min-w-0 border-t border-fg/15 py-3"
                        tabindex="-1"
                    >
                        <h4 class="mb-2 text-sm font-bold text-fg/80">
                            {{ propertyFieldLabel(row.field) }}
                        </h4>
                        <!-- An added or removed entry has one side: its value, with no Before and After. -->
                        <div
                            v-if="section.status"
                            class="min-w-0"
                            v-bind="{
                                [`data-property-${section.status === 'added' ? 'after' : 'before'}`]:
                                    '',
                            }"
                        >
                            <PropertyChangeValue
                                :value="section.status === 'added' ? row.after : row.before"
                                :field="row.field"
                            />
                        </div>
                        <div v-else class="grid min-w-0 grid-cols-2 gap-3">
                            <div class="min-w-0" data-property-before>
                                <p class="mb-1 text-xs text-fg/80">
                                    {{ i18n.historyChanges.before }}
                                </p>
                                <PropertyChangeValue :value="row.before" :field="row.field" />
                            </div>
                            <div class="min-w-0" data-property-after>
                                <p class="mb-1 text-xs text-fg/80">
                                    {{ i18n.historyChanges.after }}
                                </p>
                                <PropertyChangeValue :value="row.after" :field="row.field" />
                            </div>
                        </div>
                    </div>
                </section>
                <div
                    v-if="page.shown < page.total"
                    class="flex flex-wrap items-center gap-2"
                    data-property-count
                >
                    <span>{{
                        interpolateRaw(
                            i18n.historyChanges.shown,
                            propertyCount(page.shown),
                            propertyCount(page.total),
                        )
                    }}</span>
                    <button
                        type="button"
                        class="btn btn-secondary h-9 min-w-24 max-w-full truncate rounded-full px-4"
                        data-property-more
                        @click="showMore"
                    >
                        {{ i18n.historyChanges.showMore }}
                    </button>
                </div>
            </div>
        </div>
    </BaseModal>
</template>
