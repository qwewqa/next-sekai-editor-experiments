<script setup lang="ts">
import { computed, ref } from 'vue'
import { getHistoryOperationContext } from '../../history/createHistoryOperation'
import {
    captureOperationRecipe,
    describeMember,
    describeStep,
    message,
    operationDetails,
    operationStepCount,
    type OperationMember,
    type OperationRecipe,
} from '../../history/operationPresentation'
import { i18n } from '../../i18n'
import { formatDateTimeSeconds } from '../../i18n/when'

const props = defineProps<{ recipe: OperationRecipe; time?: number; summaryProvided?: boolean }>()
const PAGE = 20
const limit = ref(PAGE)
const recoveryLimit = ref(PAGE)
const expanded = ref<ReadonlySet<number>>(new Set())
const context = computed(getHistoryOperationContext)
const memberContext = computed(() => ({ ...context.value, qualifiers: props.recipe.qualifiers }))
const details = computed(() => operationDetails(props.recipe, context.value))
const children = computed(() => details.value.children.slice(0, limit.value))
const recovery = computed(() => details.value.recovery?.descriptions.slice(0, recoveryLimit.value))
const childRecipe = (member: OperationMember) =>
    captureOperationRecipe([member], { qualifiers: props.recipe.qualifiers })
const toggle = (index: number, event: Event) => {
    const next = new Set(expanded.value)
    if ((event.currentTarget as HTMLDetailsElement).open) next.add(index)
    else next.delete(index)
    expanded.value = next
}
</script>

<template>
    <div
        class="min-w-0 select-text space-y-5 text-sm [overflow-wrap:anywhere]"
        data-operation-details
    >
        <div v-if="!summaryProvided" class="space-y-1">
            <p class="whitespace-pre-wrap font-bold" data-operation-description>
                {{ details.description }}
            </p>
            <p v-if="time !== undefined" class="text-fg/75" data-operation-time>
                {{ formatDateTimeSeconds(time) }}
            </p>
            <p v-if="recipe.kind !== 'single'" data-operation-count>
                {{ operationStepCount(recipe, context) }}
            </p>
        </div>
        <p v-if="details.explanation" data-operation-unsupported>{{ details.explanation }}</p>
        <section
            v-for="section in details.sections"
            :key="section.key"
            :data-operation-section="section.key"
        >
            <h3 class="mb-2 font-bold">{{ section.label }}</h3>
            <dl class="space-y-3">
                <div
                    v-for="row in section.rows"
                    :key="row.key"
                    :data-operation-field="row.key"
                    class="min-w-0"
                >
                    <dt class="text-xs text-fg/75">{{ row.label }}</dt>
                    <dd class="whitespace-pre-wrap">{{ row.value }}</dd>
                    <dd
                        v-if="row.nameShortened"
                        class="text-xs text-fg/75"
                        data-operation-shortened
                    >
                        {{ i18n.history.details.nameShortened }}
                    </dd>
                </div>
            </dl>
        </section>
        <div v-if="children.length" class="space-y-2" data-operation-children>
            <details
                v-for="(member, index) in children"
                :key="member.id ?? index"
                class="border-t border-fg/15"
                @toggle="toggle(index, $event)"
            >
                <summary
                    class="min-h-11 cursor-pointer py-3 font-bold outline-offset-2 focus-visible:outline focus-visible:outline-2"
                >
                    <span class="whitespace-pre-wrap">{{ describeMember(member, memberContext) }}</span>
                    <span
                        v-if="member.time !== undefined"
                        class="block pl-4 text-xs font-normal text-fg/75"
                        >{{ formatDateTimeSeconds(member.time) }}</span
                    >
                </summary>
                <OperationDetailsContent
                    v-if="expanded.has(index)"
                    :recipe="childRecipe(member)"
                    :time="member.time"
                    summary-provided
                    class="pb-4 pl-4"
                />
            </details>
            <button
                v-if="children.length < details.children.length"
                type="button"
                class="min-h-11 rounded-full bg-button px-4 py-2 font-bold focus-visible:outline focus-visible:outline-2"
                data-operation-more
                @click="limit += PAGE"
            >
                {{ i18n.historyChanges.showMore }}
            </button>
        </div>
        <section v-if="details.recovery" class="space-y-3" data-operation-recovery>
            <h3 class="font-bold">{{ i18n.history.details.recoveryContext }}</h3>
            <ol class="space-y-3">
                <li v-for="(step, index) in recovery" :key="index" class="whitespace-pre-wrap">
                    <p
                        v-if="index === details.recovery.headIndex"
                        class="text-xs font-bold"
                        data-operation-recovery-head
                    >
                        {{ i18n.history.details.recoveryHead }}
                    </p>
                    <p>{{ describeStep(step, context) }}</p>
                </li>
            </ol>
            <button
                v-if="(recovery?.length ?? 0) < details.recovery.descriptions.length"
                type="button"
                class="min-h-11 rounded-full bg-button px-4 py-2 font-bold focus-visible:outline focus-visible:outline-2"
                @click="recoveryLimit += PAGE"
            >
                {{ i18n.historyChanges.showMore }}
            </button>
            <p v-if="details.recovery.omitted" class="text-fg/75">
                {{
                    message(
                        context,
                        i18n.history.details.omittedDescriptions,
                        details.recovery.omitted,
                    )
                }}
            </p>
        </section>
    </div>
</template>
