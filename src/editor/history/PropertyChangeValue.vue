<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { i18n } from '../../i18n'
import { interpolateRaw } from '../../utils/interpolate'
import {
    PROPERTY_PAGE_SIZE,
    propertyItems,
    propertyTagIcon,
    type PropertyField,
    type PropertyValue,
} from './propertyChanges'
import { propertyCount, propertyReferenceText, propertyValueText } from './propertyPresentation'

const props = defineProps<{ value: PropertyValue; field?: PropertyField }>()
const limit = ref(PROPERTY_PAGE_SIZE)
watch(
    () => props.value,
    () => {
        limit.value = PROPERTY_PAGE_SIZE
    },
)
const page = computed(() =>
    props.value.kind === 'list' ? propertyItems(props.value, limit.value) : undefined,
)
</script>

<template>
    <div class="property-value min-w-0 select-text whitespace-pre-wrap" data-property-value>
        <template v-if="value.kind !== 'list'">{{ propertyValueText(value, field) }}</template>
        <template v-else-if="page">
            <ol class="list-inside list-decimal space-y-2" data-property-items>
                <li v-for="(item, index) in page.items" :key="index">
                    <template v-if="item.kind === 'reference'">{{
                        propertyReferenceText(item)
                    }}</template>
                    <template v-else>
                        <span>{{ item.title || i18n.historyChanges.notSet }}</span>
                        <div class="mt-1 flex flex-wrap gap-x-2 text-xs text-fg/80">
                            <span>{{ i18n.historyChanges.fields.icon }}</span>
                            <PropertyChangeValue :value="propertyTagIcon(item)" />
                        </div>
                    </template>
                </li>
            </ol>
            <!-- "Items: n/m" only while more remain, as Properties: n/m (DEC-8.1). -->
            <div
                v-if="page.items.length < page.total"
                class="mt-2 flex flex-wrap items-center gap-2"
                data-property-items-count
            >
                <span>{{
                    interpolateRaw(
                        i18n.historyChanges.itemsShown,
                        propertyCount(page.items.length),
                        propertyCount(page.total),
                    )
                }}</span>
                <button
                    type="button"
                    class="btn btn-secondary h-9 min-w-24 max-w-full truncate rounded-full px-4"
                    data-property-items-more
                    @click="limit += PROPERTY_PAGE_SIZE"
                >
                    {{ i18n.historyChanges.showMore }}
                </button>
            </div>
        </template>
    </div>
</template>

<style scoped>
.property-value {
    overflow-wrap: anywhere;
}
</style>
