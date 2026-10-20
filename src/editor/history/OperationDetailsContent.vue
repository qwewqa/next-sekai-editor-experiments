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
import DetailsHeader from './DetailsHeader.vue'
import type { Flags } from './rows'

const props = defineProps<{
    recipe: OperationRecipe
    time?: number
    summaryProvided?: boolean
    /** The opener row's flags: removed to save space or damaged, shown in the meta line. */
    flags?: Flags
    /** A group's steps, by member id. */
    memberFlags?: ReadonlyMap<string, Flags>
}>()
const PAGE = 20
const limit = ref(PAGE)
const recoveryLimit = ref(PAGE)
const childList = useTemplateRef<HTMLElement>('childList')
const recoveryList = useTemplateRef<HTMLElement>('recoveryList')
const expanded = ref<ReadonlySet<number>>(new Set())
const context = computed(getHistoryOperationContext)
const details = computed(() => operationDetails(props.recipe, context.value))
const members = computed(() => details.value.steps?.members.slice(0, limit.value) ?? [])
const recovery = computed(() => details.value.recovery?.descriptions.slice(0, recoveryLimit.value))
// A block with nothing to show is not rendered, so no heading or rule stands over nothing.
const rows = computed(() =>
    details.value.rows.filter((row) => row.kind !== 'counts' || row.items.length > 0),
)
const facts = computed(() => details.value.facts.filter(Boolean))
const childRecipe = (member: OperationMember) => captureOperationRecipe([member])
const flagText = (flags: Flags | undefined) =>
    flags?.damaged
        ? i18n.value.history.damaged
        : flags?.newer
          ? i18n.value.history.needsNewer
          : flags?.removed
            ? i18n.value.history.removedForSpace
            : undefined
const meta = computed(() =>
    [
        props.time === undefined ? undefined : formatDateTimeSeconds(props.time),
        flagText(props.flags),
    ]
        .filter(Boolean)
        .join(' · '),
)
// A step's own flag is news only when it is not its group row's: a removed group holds removed
// steps, and the meta line has said so.
const memberFlagText = (member: OperationMember) => {
    const text = member.id === undefined ? undefined : flagText(props.memberFlags?.get(member.id))
    return text === flagText(props.flags) ? undefined : text
}
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
    const row = childList.value?.children[first]
    ;(row?.querySelector<HTMLElement>('summary') ?? (row as HTMLElement | undefined))?.focus()
}
const showMoreRecovery = async () => {
    const first = recoveryLimit.value
    recoveryLimit.value += PAGE
    if (recoveryLimit.value < (details.value.recovery?.descriptions.length ?? 0)) return
    await nextTick()
    ;(recoveryList.value?.children[first]?.firstElementChild as HTMLElement | undefined)?.focus()
}
// A step on its group's day shows its clock; the group's own line gives the date.
const childTime = (at: number) =>
    props.time !== undefined && new Date(at).toDateString() === new Date(props.time).toDateString()
        ? formatClockSeconds(at)
        : formatDateTimeSeconds(at)
const placeholder = (text: DetailText) => (text.placeholder ? 'text-fg/80' : undefined)
</script>

<template>
    <!-- Opened from the keyboard, focus lands here, so the dialog opens at its top. -->
    <div
        class="details-root min-w-0 select-text flex-col gap-4 outline-none [overflow-wrap:anywhere]"
        :class="summaryProvided ? 'block' : 'flex'"
        :tabindex="summaryProvided ? undefined : -1"
        :data-autofocus="summaryProvided ? undefined : ''"
        :data-nested="summaryProvided ? '' : undefined"
        data-operation-details
    >
        <DetailsHeader
            v-if="!summaryProvided"
            scope="operation"
            :title="details.description"
            :title-lang="details.descriptionLang"
            :meta="meta"
        />
        <p v-if="details.note" :class="{ 'pb-2': summaryProvided }" data-operation-unsupported>
            {{ details.note }}
        </p>
        <div v-if="rows.length || facts.length" class="record" data-operation-record>
            <dl v-if="rows.length" class="table">
                <div v-for="row in rows" :key="row.key" :data-operation-field="row.key">
                    <dt>{{ row.label }}</dt>
                    <dd>
                        <ul v-if="row.kind === 'counts'" class="tabular-nums">
                            <li v-for="item in row.items" :key="item">{{ item }}</li>
                        </ul>
                        <div
                            v-else-if="row.kind === 'change'"
                            class="flex flex-wrap items-baseline gap-x-2"
                        >
                            <span class="sr-only">{{ i18n.historyChanges.before }}{{ ' ' }}</span>
                            <span class="min-w-0 tabular-nums" :class="placeholder(row.before)">{{
                                row.before.text
                            }}</span>
                            <span class="inline-flex min-w-0 items-baseline gap-x-2">
                                <span class="flex h-6 shrink-0 items-center self-start">
                                    <ChevronIcon direction="right" class="text-fg/70" />
                                </span>
                                <span class="sr-only"
                                    >{{ ' ' }}{{ i18n.historyChanges.after }}{{ ' ' }}</span
                                >
                                <span
                                    class="min-w-0 tabular-nums"
                                    :class="placeholder(row.after)"
                                    >{{ row.after.text }}</span
                                >
                            </span>
                        </div>
                        <span v-else :class="placeholder(row.value)">{{ row.value.text }}</span>
                    </dd>
                </div>
            </dl>
            <ul v-if="facts.length" class="lines">
                <li v-for="fact in facts" :key="fact" data-operation-fact>{{ fact }}</li>
            </ul>
        </div>
        <!-- The group's steps, newest first: the chevron leading, the time at the end. -->
        <section v-if="members.length" data-operation-children>
            <!-- An undo or redo parent's title already carries the count. -->
            <h3 v-if="!details.steps?.prefixless" class="mb-1 font-bold" data-operation-count>
                {{ operationStepCount(recipe, context) }}
            </h3>
            <div
                ref="childList"
                :role="details.steps?.prefixless ? 'group' : undefined"
                :aria-label="
                    details.steps?.prefixless ? operationStepCount(recipe, context) : undefined
                "
            >
                <template v-for="(entry, index) in members" :key="entry.member.id ?? index">
                    <details
                        v-if="entry.expandable"
                        class="border-t border-fg/15"
                        @toggle="toggle(index, $event)"
                    >
                        <summary
                            class="ghost flex cursor-pointer list-none items-baseline gap-2 rounded-lg px-2 py-2 [&::-webkit-details-marker]:hidden"
                        >
                            <span class="flex h-6 shrink-0 items-center self-start">
                                <ChevronIcon
                                    :direction="expanded.has(index) ? 'down' : 'right'"
                                    class="text-fg/70"
                                />
                            </span>
                            <span class="min-w-0 flex-1 whitespace-pre-wrap"
                                >{{ entry.label
                                }}<span v-if="memberFlagText(entry.member)" class="text-fg/80">{{
                                    ` · ${memberFlagText(entry.member)}`
                                }}</span></span
                            >
                            <span
                                v-if="entry.member.time !== undefined"
                                class="shrink-0 text-xs tabular-nums text-fg/80"
                                >{{ childTime(entry.member.time) }}</span
                            >
                        </summary>
                        <OperationDetailsContent
                            v-if="expanded.has(index)"
                            :recipe="childRecipe(entry.member)"
                            :time="entry.member.time"
                            summary-provided
                            class="pb-4 pl-7 pr-2"
                        />
                    </details>
                    <!-- The rule is the outer box's and the radius the inner one's, as on a row that opens. -->
                    <div v-else class="border-t border-fg/15">
                        <div
                            class="focus-edge flex items-baseline gap-2 rounded-lg px-2 py-2"
                            tabindex="-1"
                            data-operation-step
                        >
                            <span class="size-3 shrink-0 self-start" aria-hidden="true"></span>
                            <span class="min-w-0 flex-1 whitespace-pre-wrap"
                                >{{ entry.label
                                }}<span v-if="memberFlagText(entry.member)" class="text-fg/80">{{
                                    ` · ${memberFlagText(entry.member)}`
                                }}</span></span
                            >
                            <span
                                v-if="entry.member.time !== undefined"
                                class="shrink-0 text-xs tabular-nums text-fg/80"
                                >{{ childTime(entry.member.time) }}</span
                            >
                        </div>
                    </div>
                </template>
            </div>
            <button
                v-if="members.length < (details.steps?.members.length ?? 0)"
                type="button"
                class="btn btn-secondary mt-2 h-9 min-w-24 max-w-full truncate rounded-full px-4"
                data-operation-more
                @click="showMore"
            >
                {{ i18n.historyChanges.showMore }}
            </button>
        </section>
        <section v-if="details.recovery" data-operation-recovery>
            <h3 class="mb-1 font-bold">{{ i18n.history.details.recoveryContext }}</h3>
            <!-- Ruled as the steps list is: a rule over each row, which is 8 px in from its rule. -->
            <ol ref="recoveryList">
                <li v-for="(step, index) in recovery" :key="index" class="border-t border-fg/15">
                    <div class="focus-edge whitespace-pre-wrap rounded-lg px-2 py-2" tabindex="-1">
                        <p
                            v-if="index === details.recovery.headIndex"
                            class="text-xs font-bold"
                            data-operation-recovery-head
                        >
                            {{ i18n.history.details.recoveryHead }}
                        </p>
                        <p>{{ describeStep(step, context) }}</p>
                    </div>
                </li>
            </ol>
            <button
                v-if="(recovery?.length ?? 0) < details.recovery.descriptions.length"
                type="button"
                class="btn btn-secondary mt-2 h-9 min-w-24 max-w-full truncate rounded-full px-4"
                @click="showMoreRecovery"
            >
                {{ i18n.historyChanges.showMore }}
            </button>
            <p v-if="details.recovery.omitted" class="mt-2 text-fg/80">
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

<style scoped>
/* The record table: a label column as wide as the labels (at most 40 %), the values beside it, and a
   hairline above every row, so each rule runs unbroken across both columns. */
.details-root {
    container-type: inline-size;
}
.record .table {
    display: grid;
    grid-template-columns: fit-content(40%) minmax(0, 1fr);
}
.record .table > div {
    display: contents;
}
.record dt {
    @apply border-t border-fg/15 pb-2 pr-4 pt-2.5 text-sm text-fg/80;
}
.record dd {
    @apply min-w-0 whitespace-pre-wrap border-t border-fg/15 py-2;
}
.record ul {
    list-style: none;
}
.record .lines li {
    @apply whitespace-pre-wrap border-t border-fg/15 py-2;
}
/* A nested record sits under its step's own rule. */
[data-nested] .record > :first-child > div:first-child > *,
[data-nested] .record > .lines:first-child > li:first-child {
    @apply border-t-0;
}
@container (max-width: 19rem) {
    .record .table {
        grid-template-columns: minmax(0, 1fr);
    }
    .record dt {
        @apply pb-0 pr-0;
    }
    .record dd {
        @apply border-t-0 pt-0.5;
    }
}
</style>
