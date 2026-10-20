<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef, watch } from 'vue'
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
const list = useTemplateRef<HTMLElement>('list')
// Revealing the rest removes the button, so focus moves to the first new item.
const showMore = async () => {
    const first = page.value?.items.length ?? 0
    limit.value += PROPERTY_PAGE_SIZE
    await nextTick()
    if (page.value && page.value.items.length < page.value.total) return
    ;(list.value?.children[first] as HTMLElement | undefined)?.focus()
}
const page = computed(() =>
    props.value.kind === 'list' ? propertyItems(props.value, limit.value) : undefined,
)
</script>

<template>
    <div
        class="property-value min-w-0 select-text whitespace-pre-wrap"
        :class="value.kind === 'notSet' || value.kind === 'notPresent' ? 'text-fg/80' : undefined"
        data-property-value
    >
        <template v-if="value.kind !== 'list'">{{ propertyValueText(value, field) }}</template>
        <template v-else-if="page">
            <ol ref="list" class="list-inside list-decimal space-y-2" data-property-items>
                <li
                    v-for="(item, index) in page.items"
                    :key="index"
                    class="focus-edge rounded focus-visible:outline-offset-2"
                    tabindex="-1"
                >
                    <template v-if="item.kind === 'reference'">{{
                        propertyReferenceText(item)
                    }}</template>
                    <template v-else>
                        <span :class="item.title ? undefined : 'text-fg/80'">{{
                            item.title || i18n.historyChanges.notSet
                        }}</span>
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
                    @click="showMore"
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
