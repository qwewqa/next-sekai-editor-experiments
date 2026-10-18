<script setup lang="ts">
import { computed, useId, useTemplateRef } from 'vue'
import { i18n } from '../../i18n'
import { peekedKey } from '../../history/peek'
import { getPanelSide } from '../workspace'
import CloseIcon from '../workspace/CloseIcon.vue'
import RecentSessionsTab from './RecentSessionsTab.vue'
import TimelineList from './TimelineList.vue'
import type { Filter } from './rows'
import { backToNow, peekedInfo } from './selection'
import { historyFilter, historyTab, type HistoryTab } from './state'

// The History panel (Part 1 §1.4.10): two tabs, Timeline and Recent Sessions. There is no action
// bar in it: the peek's controls are on the canvas (§1.4.11), so the body is all list.

const props = withDefaults(defineProps<{ surface?: 'panel' | 'dialog' }>(), { surface: 'panel' })
const emit = defineEmits<{ close: [] }>()

const tabs: readonly HistoryTab[] = ['timeline', 'sessions']
const filters: readonly Filter[] = ['all', 'saves']

const id = useId()
const tabId = (tab: HistoryTab) => `${id}-tab-${tab}`
const panelId = `${id}-panel`

const title = (tab: HistoryTab) =>
    tab === 'timeline' ? i18n.value.history.timeline : i18n.value.history.recentSessions
const filterTitle = (filter: Filter) =>
    filter === 'all' ? i18n.value.history.filterAll : i18n.value.history.filterSaves

// Rows are one line in the top dock and two in the side docks.
const twoLine = computed(() => getPanelSide('history') !== 'top')

const tablist = useTemplateRef<HTMLElement>('tablist')

// Outside the list, Escape in the dialog is back to Now first, then close.
const onEscape = (event: KeyboardEvent) => {
    if (props.surface !== 'dialog' || event.defaultPrevented) return
    event.preventDefault()
    event.stopPropagation()
    if (peekedKey.value || peekedInfo.value) backToNow()
    else emit('close')
}

const select = (tab: HistoryTab) => {
    historyTab.value = tab
}

const onTabKeydown = (event: KeyboardEvent) => {
    const at = tabs.indexOf(historyTab.value)
    let next: number
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (at + 1) % tabs.length
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
        next = (at - 1 + tabs.length) % tabs.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = tabs.length - 1
    else return
    event.preventDefault()
    const tab = tabs[next]
    if (!tab) return
    select(tab)
    tablist.value?.querySelector<HTMLElement>(`#${CSS.escape(tabId(tab))}`)?.focus()
}

// Pointer clicks return keyboard shortcuts to the editor, except where the panel takes them.
const blurAfterPointer = (event: MouseEvent) => {
    if (event.detail > 0) (event.currentTarget as HTMLElement).blur()
}

// High contrast paints only the outlines: the track's is its edge, the segment's shows focus.
const segment =
    'flex h-7 items-center justify-center rounded-full px-3 text-sm transition-colors [@media(pointer:coarse)]:h-10'
</script>

<template>
    <div
        class="history-panel flex h-full min-h-0 flex-col bg-modal text-fg"
        :data-history-surface="surface"
        @keydown.esc="onEscape"
    >
        <div
            class="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 bg-header px-1.5 py-1 [@media(pointer:coarse)]:py-0.5"
        >
            <div
                ref="tablist"
                role="tablist"
                class="flex min-w-0 flex-[3_1_15rem] rounded-full bg-recess p-0.5 shadow-track"
                :aria-label="i18n.history.title"
            >
                <button
                    v-for="tab in tabs"
                    :id="tabId(tab)"
                    :key="tab"
                    type="button"
                    role="tab"
                    class="history-segment relative min-w-0 flex-1 rounded-full outline-none"
                    :aria-selected="historyTab === tab"
                    :aria-controls="historyTab === tab ? panelId : undefined"
                    :tabindex="historyTab === tab ? 0 : -1"
                    :title="title(tab)"
                    @click="(select(tab), blurAfterPointer($event))"
                    @keydown="onTabKeydown"
                >
                    <span :class="[segment, { 'history-segment-on': historyTab === tab }]"
                        ><span class="truncate">{{ title(tab) }}</span></span
                    >
                </button>
            </div>
            <div
                v-if="historyTab === 'timeline'"
                role="group"
                class="flex min-w-0 flex-[1_1_auto] rounded-full bg-recess p-0.5 shadow-track"
                :aria-label="i18n.history.timeline"
            >
                <button
                    v-for="filter in filters"
                    :key="filter"
                    type="button"
                    class="history-segment relative min-w-0 flex-1 rounded-full outline-none"
                    :aria-pressed="historyFilter === filter"
                    @click="((historyFilter = filter), blurAfterPointer($event))"
                >
                    <span
                        :class="[
                            segment,
                            'filter-segment',
                            { 'history-segment-on': historyFilter === filter },
                        ]"
                        ><span class="truncate">{{ filterTitle(filter) }}</span></span
                    >
                </button>
            </div>
            <button
                v-if="surface === 'dialog'"
                type="button"
                class="ml-auto flex size-9 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-band-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg active:bg-accent active:text-on-accent [@media(pointer:coarse)]:size-11"
                :aria-label="i18n.modals.close"
                :title="i18n.modals.close"
                data-history-close
                @click="emit('close')"
            >
                <CloseIcon class="size-4 [@media(pointer:coarse)]:size-5" />
            </button>
        </div>
        <div
            :id="panelId"
            role="tabpanel"
            class="min-h-0 flex-1"
            :aria-labelledby="tabId(historyTab)"
        >
            <TimelineList
                v-if="historyTab === 'timeline'"
                :two-line
                :surface="props.surface"
                @close="emit('close')"
            />
            <RecentSessionsTab v-else />
        </div>
    </div>
</template>

<style scoped>
.filter-segment {
    @apply h-6 text-xs [@media(pointer:coarse)]:h-8;
}

.history-segment-on {
    @apply bg-button shadow-md;
}

.history-segment:focus-visible > span {
    @apply ring-2 ring-fg;
}

@media (hover: hover) {
    .history-segment:not(:active):hover > span:not(.history-segment-on) {
        @apply bg-button/50;
    }
}

.history-segment:active > span {
    @apply bg-accent text-on-accent;
}
</style>
