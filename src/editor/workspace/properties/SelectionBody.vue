<script setup lang="ts">
import { computed, provide } from 'vue'
import { isDynamicStages } from '../../../history/dynamicStages.ts'
import { selectedEntities } from '../../../history/selectedEntities'
import { store } from '../../../history/store'
import { i18n } from '../../../i18n'
import type { Entity, EntityType } from '../../../state/entities'
import { isEditableEntity } from '../../../state/operations/editable'
import type { Store } from '../../../state/store'
import { stackLongValuesKey } from '../../../modals/form/fieldLayout'
import { providePropertyDescriptions } from '../../../modals/form/propertyDescription'
import { aggregateEntities, mergeAggregates, type EntitiesAggregate } from '../../utils/properties'
import { layoutFields, propertyFields, type SelectionContext } from './fields'
import PropertiesBlock from './PropertiesBlock.vue'
import { summarizeSelection, type SummaryKind } from './summary'

const props = defineProps<{
    /** Shows only this kind's objects, as a kind's dialog does. */
    kind?: SummaryKind
}>()

// Long values go below their label, as in View.
provide(stackLongValuesKey, true)
providePropertyDescriptions(true)

const entities = computed(() =>
    selectedEntities.value.filter(
        (entity) => isEditableEntity(entity) && (!props.kind || entity.type === props.kind),
    ),
)

const summary = computed(() =>
    summarizeSelection(
        entities.value,
        (slideId) => store.value.slides.note.get(slideId)?.length ?? 0,
    ),
)

type KindAggregate = { entities: Entity[]; aggregate: EntitiesAggregate }

const sameEntities = (a: readonly Entity[], b: readonly Entity[]) =>
    a.length === b.length && a.every((entity, i) => entity === b[i])

// Each kind is aggregated once, kept while its objects and the chart stay; General merges them.
let previous: { store: Store; kinds: Map<EntityType, KindAggregate> } | undefined
const byKind = computed(() => {
    const current = store.value
    const groups = new Map<EntityType, Entity[]>()
    for (const entity of entities.value) {
        const group = groups.get(entity.type)
        if (group) group.push(entity)
        else groups.set(entity.type, [entity])
    }
    const kept = previous?.store === current ? previous.kinds : undefined
    const kinds = new Map(
        [...groups].map(([kind, list]): [EntityType, KindAggregate] => {
            const old = kept?.get(kind)
            return [
                kind,
                old && sameEntities(old.entities, list)
                    ? old
                    : { entities: list, aggregate: aggregateEntities(list) },
            ]
        }),
    )
    previous = { store: current, kinds }
    return kinds
})

// The keys General shows for several kinds.
const generalKeys = propertyFields.flatMap((field) => (field.general ? [field.key] : []))

const context = (counts: SelectionContext['counts']): SelectionContext => ({
    counts,
    noteFields: byKind.value.get('note')?.aggregate.noteFields ?? {},
    isDynamicStages: isDynamicStages.value,
})

const blocks = computed(() => {
    const kinds = summary.value.kinds.map(({ kind }) => kind)
    const counts = new Map(summary.value.kinds.map(({ kind, count }) => [kind, count]))
    const layout = layoutFields(
        kinds,
        (kind) => context({ [kind]: counts.get(kind as SummaryKind) ?? 0 }),
        context(Object.fromEntries(counts)),
    )
    return layout.map(({ kind, sections }) => {
        const own = kind && byKind.value.get(kind)
        return {
            key: kind ?? 'general',
            kind: kind as SummaryKind | undefined,
            sections,
            entities: own ? own.entities : entities.value,
            aggregate: own
                ? own.aggregate
                : mergeAggregates(
                      [...byKind.value.values()].map(({ aggregate }) => aggregate),
                      generalKeys,
                  ),
            count: kind ? (counts.get(kind as SummaryKind) ?? 0) : entities.value.length,
            slides: kind === 'note' ? summary.value.slides : 0,
        }
    })
})
</script>

<template>
    <p v-if="!entities.length" class="text-fg/80">{{ i18n.sidebars.default.none }}</p>
    <PropertiesBlock
        v-for="block in blocks"
        v-else
        :key="block.key"
        :kind="block.kind"
        :entities="block.entities"
        :aggregate="block.aggregate"
        :sections="block.sections"
        :count="block.count"
        :slides="block.slides"
        :narrowable="blocks.length > 1"
    />
</template>
