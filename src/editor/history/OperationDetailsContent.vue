<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef } from 'vue'
import { getHistoryOperationContext } from '../../history/createHistoryOperation'
import {
    captureOperationRecipe,
    describeStep,
    message,
    operationDetails,
    operationStepCount,
    type DetailText,
    type OperationMember,
    type OperationRecipe,
} from '../../history/operationPresentation'
import { i18n } from '../../i18n'
import { formatClockSeconds, formatDateTimeSeconds } from '../../i18n/when'
import ChevronIcon from '../workspace/ChevronIcon.vue'

const props = defineProps<{ recipe: OperationRecipe; time?: number; summaryProvided?: boolean }>()
const PAGE = 20
const limit = ref(PAGE)
const recoveryLimit = ref(PAGE)
const childList = useTemplateRef<HTMLElement>('childList')
const recoveryList = useTemplateRef<HTMLElement>('recoveryList')
const expanded = ref<ReadonlySet<number>>(new Set())
const context = computed(getHistoryOperationContext)
const details = computed(() => operationDetails(props.recipe, context.value))
const children = computed(() => details.value.steps?.members.slice(0, limit.value) ?? [])
const recovery = computed(() => details.value.recovery?.descriptions.slice(0, recoveryLimit.value))
const childRecipe = (member: OperationMember) => captureOperationRecipe([member])
const placeholderClass = (value: DetailText) => (value.placeholder ? 'text-fg/80' : undefined)
const toggle = (index: number, event: Event) => {
    const next = new Set(expanded.value)
    if ((event.currentTarget as HTMLDetailsElement).open) next.add(index)
    else next.delete(index)
    expanded.value = next
}
// Revealing the rest removes the button, so focus moves to the first new entry.
const showMore = async () => {
    const first = limit.value
    limit.value += PAGE
    if (limit.value < (details.value.steps?.members.length ?? 0)) return
    await nextTick()
    childList.value?.children[first]?.querySelector('summary')?.focus()
}
const showMoreRecovery = async () => {
    const first = recoveryLimit.value
    recoveryLimit.value += PAGE
    if (recoveryLimit.value < (details.value.recovery?.descriptions.length ?? 0)) return
    await nextTick()
    ;(recoveryList.value?.children[first] as HTMLElement | undefined)?.focus()
}
// A step on its group's day shows its clock; the group's own line gives the date.
const childTime = (at: number) =>
    props.time !== undefined && new Date(at).toDateString() === new Date(props.time).toDateString()
        ? formatClockSeconds(at)
        : formatDateTimeSeconds(at)
</script>

<template>
    <!-- Opened from the keyboard, focus lands here, so the dialog opens at its top. -->
    <div
        class="min-w-0 select-text space-y-5 outline-none [overflow-wrap:anywhere]"
        :tabindex="summaryProvided ? undefined : -1"
        :data-autofocus="summaryProvided ? undefined : ''"
        data-operation-details
    >
        <div v-if="!summaryProvided" class="space-y-1">
            <p
                class="whitespace-pre-wrap font-bold"
                :lang="details.descriptionLang"
                data-operation-description
            >
                {{ details.description }}
            </p>
            <p v-if="time !== undefined" class="text-fg/80" data-operation-time>
                {{ formatDateTimeSeconds(time) }}
            </p>
            <p v-if="recipe.kind !== 'single'" data-operation-count>
                {{ operationStepCount(recipe, context) }}
            </p>
        </div>
        <p v-if="details.note" data-operation-unsupported>{{ details.note }}</p>
        <dl v-if="details.rows.length" class="space-y-3">
            <div
                v-for="row in details.rows"
                :key="row.key"
                :data-operation-field="row.key"
                class="min-w-0"
            >
                <dt class="text-xs text-fg/80">{{ row.label }}</dt>
                <dd v-if="row.kind === 'counts'" class="whitespace-pre-wrap">
                    <span v-for="item in row.items" :key="item" class="block">{{ item }}</span>
                </dd>
                <dd v-else-if="row.kind === 'change'" class="whitespace-pre-wrap">
                    <span :class="placeholderClass(row.before)">{{ row.before.text }}</span>
                    ›
                    <span :class="placeholderClass(row.after)">{{ row.after.text }}</span>
                </dd>
                <dd v-else class="whitespace-pre-wrap" :class="placeholderClass(row.value)">
                    {{ row.value.text }}
                </dd>
            </div>
        </dl>
        <ul v-if="details.facts.length" class="space-y-1" data-operation-facts>
            <li v-for="fact in details.facts" :key="fact">{{ fact }}</li>
        </ul>
        <!-- The group's steps: one line each, the chevron leading, the time at the end. -->
        <div v-if="children.length" class="space-y-2" data-operation-children>
            <div ref="childList">
                <details
                    v-for="({ member, label }, index) in children"
                    :key="member.id ?? index"
                    class="border-t border-fg/15"
                    @toggle="toggle(index, $event)"
                >
                    <summary
                        class="ghost flex cursor-pointer list-none items-baseline gap-2 rounded-lg px-2 py-2 [&::-webkit-details-marker]:hidden"
                    >
                        <ChevronIcon
                            :direction="expanded.has(index) ? 'down' : 'right'"
                            class="self-center"
                        />
                        <span class="min-w-0 flex-1 whitespace-pre-wrap">{{ label }}</span>
                        <span
                            v-if="member.time !== undefined"
                            class="shrink-0 text-xs tabular-nums text-fg/80"
                            >{{ childTime(member.time) }}</span
                        >
                    </summary>
                    <OperationDetailsContent
                        v-if="expanded.has(index)"
                        :recipe="childRecipe(member)"
                        :time="member.time"
                        summary-provided
                        class="pb-4 pl-7 pr-2"
                    />
                </details>
            </div>
            <button
                v-if="children.length < (details.steps?.members.length ?? 0)"
                type="button"
                class="btn btn-secondary h-9 min-w-24 max-w-full truncate rounded-full px-4"
                data-operation-more
                @click="showMore"
            >
                {{ i18n.historyChanges.showMore }}
            </button>
        </div>
        <section v-if="details.recovery" class="space-y-3" data-operation-recovery>
            <h3 class="font-bold">{{ i18n.history.details.recoveryContext }}</h3>
            <ol ref="recoveryList" class="space-y-3">
                <li
                    v-for="(step, index) in recovery"
                    :key="index"
                    class="focus-edge whitespace-pre-wrap"
                    tabindex="-1"
                >
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
                class="btn btn-secondary h-9 min-w-24 max-w-full truncate rounded-full px-4"
                @click="showMoreRecovery"
            >
                {{ i18n.historyChanges.showMore }}
            </button>
            <p v-if="details.recovery.omitted" class="text-fg/80">
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
