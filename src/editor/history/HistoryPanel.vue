<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, useTemplateRef } from 'vue'
import { peekedKey } from '../../history/peek'
import { i18n } from '../../i18n'
import ChevronIcon from '../workspace/ChevronIcon.vue'
import CloseIcon from '../workspace/CloseIcon.vue'
import GoToIcon from './GoToIcon.vue'
import GoToList from './GoToList.vue'
import GoToPopover from './GoToPopover.vue'
import { hereRangeText } from './editsHere'
import RecentSessionsTab from './RecentSessionsTab.vue'
import { backToNow, peekedInfo } from './selection'
import type { Target } from './source'
import { hereRange, historyFilter, historyTab, type HistoryTab } from './state'
import TimelineList from './TimelineList.vue'

// The History panel (Part 1 §1.4.10), in a dock or in the dialog: one band with the two tabs,
// Timeline and Recent Sessions, and Go To; then the list. There is no action bar in it: the peek's
// controls are on the canvas (§1.4.11), so the body is all list.

const props = withDefaults(defineProps<{ surface?: 'panel' | 'dialog' }>(), { surface: 'panel' })
const emit = defineEmits<{ close: [] }>()

const tabs: readonly HistoryTab[] = ['timeline', 'sessions']

const id = useId()
const tabId = (tab: HistoryTab) => `${id}-tab-${tab}`
const panelId = `${id}-panel`

const title = (tab: HistoryTab) =>
    tab === 'timeline' ? i18n.value.history.timeline : i18n.value.history.recentSessions

const band = useTemplateRef<HTMLElement>('band')
const tablist = useTemplateRef<HTMLElement>('tablist')
const goToButton = useTemplateRef<HTMLButtonElement>('goToButton')
// What the Timeline offers Go To.
type TimelineHandle = {
    focus: () => void
    jumpTo: (target: Target | 'now') => Promise<void>
    topEntry: () => Target | 'now'
}
const timeline = useTemplateRef<TimelineHandle>('timeline')

// --- The band: Go To shows its label when it fits beside the tabs, else only its icon, and in a
// dock too narrow even for that it takes a second line. The dialog's × takes its share.
const bandWidth = ref(0)
let observer: ResizeObserver | undefined
onMounted(() => {
    const element = band.value
    if (!element) return
    observer = new ResizeObserver(() => {
        bandWidth.value = element.clientWidth
    })
    observer.observe(element)
    bandWidth.value = element.clientWidth
})
onBeforeUnmount(() => observer?.disconnect())

const LABEL_FROM = 362
const ICON_FROM = 296
const mode = computed<'label' | 'icon' | 'two'>(() => {
    const extra = props.surface === 'dialog' ? 50 : 0
    if (bandWidth.value === 0 || bandWidth.value >= LABEL_FROM + extra) return 'label'
    // The dialog never wraps: its tabs give way instead.
    if (bandWidth.value >= ICON_FROM + extra || props.surface === 'dialog') return 'icon'
    return 'two'
})

const filtered = computed(() => historyFilter.value !== 'all')
// The banner: "Saves and Exports", or "Edits Here · 118.2 – 121.4".
const filterText = computed(() => {
    const range = hereRange.value
    if (historyFilter.value === 'here' && range)
        return `${i18n.value.history.filterHere} · ${hereRangeText(range)}`
    return historyFilter.value === 'here'
        ? i18n.value.history.filterHere
        : i18n.value.history.filterSaves
})
const onTimeline = computed(() => historyTab.value === 'timeline')

// --- Go To
const goToOpen = ref(false)
const closeGoTo = (restoreFocus: boolean) => {
    goToOpen.value = false
    if (restoreFocus) void nextTick(() => goToButton.value?.focus({ preventScroll: true }))
}
// The piece at the top of the list is Go To's current one.
const goToCurrent = ref<Target | 'now'>()
const openGoTo = () => {
    goToCurrent.value = timeline.value?.topEntry()
    goToOpen.value = true
}
const toggleGoTo = () => {
    if (goToOpen.value) goToOpen.value = false
    else openGoTo()
}
// Picking closes Go To, jumps there and hands the keys to the list.
const onGoToPick = (target: Target | 'now') => {
    goToOpen.value = false
    timeline.value?.focus()
    void timeline.value?.jumpTo(target)
}
const onGoToKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowDown' || goToOpen.value) return
    event.preventDefault()
    openGoTo()
}

// Outside the list, Escape in the dialog is back to Now first, then close.
const onEscape = (event: KeyboardEvent) => {
    if (props.surface !== 'dialog' || event.defaultPrevented) return
    event.preventDefault()
    event.stopPropagation()
    if (peekedKey.value || peekedInfo.value) backToNow()
    else emit('close')
}

const showAll = () => {
    historyFilter.value = 'all'
}

const select = (tab: HistoryTab) => {
    historyTab.value = tab
    goToOpen.value = false
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
// A narrow band trims the segments' padding, so both labels keep their room.
const segment = computed(
    () =>
        `flex h-7 items-center justify-center rounded-full text-sm transition-colors [@media(pointer:coarse)]:h-10 ${
            bandWidth.value > 0 && bandWidth.value < 340 ? 'px-2' : 'px-3'
        }`,
)

const goToButtonTitle = computed(() =>
    filtered.value ? `${i18n.value.history.goTo} · ${filterText.value}` : i18n.value.history.goTo,
)
</script>

<template>
    <div
        class="history-panel flex h-full min-h-0 flex-col bg-modal text-fg"
        :data-history-surface="surface"
        @keydown.esc="onEscape"
    >
        <div
            ref="band"
            class="flex shrink-0 flex-wrap items-center gap-1.5 bg-header px-2 py-1.5"
            data-history-band
            :data-band-mode="mode"
        >
            <div
                ref="tablist"
                role="tablist"
                class="flex min-w-0 flex-1 rounded-full bg-recess p-0.5 shadow-track"
                :class="mode === 'two' ? 'basis-full' : 'basis-0'"
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
            <!-- Recent Sessions keeps Go To's place, so the tabs never move. -->
            <button
                ref="goToButton"
                type="button"
                aria-haspopup="dialog"
                :aria-expanded="goToOpen"
                :aria-hidden="onTimeline ? undefined : true"
                :tabindex="onTimeline ? 0 : -1"
                class="flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-button text-sm shadow-md outline-none transition-colors hover:shadow-accent focus-visible:ring-2 focus-visible:ring-fg active:bg-accent active:text-on-accent [@media(pointer:coarse)]:h-11"
                :class="[
                    mode === 'icon'
                        ? 'w-8 justify-center [@media(pointer:coarse)]:w-11'
                        : 'pl-3 pr-2',
                    { invisible: !onTimeline },
                ]"
                :title="goToButtonTitle"
                :aria-label="i18n.history.goTo"
                data-history-goto-button
                @click="(toggleGoTo(), blurAfterPointer($event))"
                @keydown="onGoToKeydown"
            >
                <GoToIcon :filtered />
                <template v-if="mode !== 'icon'">
                    <span class="max-w-28 truncate">{{ i18n.history.goTo }}</span>
                    <ChevronIcon direction="down" class="size-2.5" />
                </template>
            </button>
            <button
                v-if="surface === 'dialog'"
                type="button"
                class="flex size-9 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-band-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg active:bg-accent active:text-on-accent [@media(pointer:coarse)]:size-11"
                :aria-label="i18n.modals.close"
                :title="i18n.modals.close"
                data-history-close
                @click="emit('close')"
            >
                <CloseIcon class="size-4 [@media(pointer:coarse)]:size-5" />
            </button>
        </div>
        <!-- While filtering, a banner says so; Show All is the way back. -->
        <div
            v-if="onTimeline && filtered"
            class="flex h-9 shrink-0 items-center justify-between border-b border-fg/15 pl-5 pr-2 text-xs [@media(pointer:coarse)]:h-11"
            data-history-filter-banner
        >
            <span class="min-w-0 truncate">{{ filterText }}</span>
            <button
                type="button"
                class="flex h-7 shrink-0 items-center rounded-full bg-button px-3 font-bold shadow-md outline-none transition-colors hover:shadow-accent focus-visible:ring-2 focus-visible:ring-fg active:bg-accent active:text-on-accent [@media(pointer:coarse)]:h-9"
                @click="(showAll(), blurAfterPointer($event))"
            >
                {{ i18n.history.showAll }}
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
                ref="timeline"
                :surface="props.surface"
                @close="emit('close')"
            />
            <RecentSessionsTab v-else />
        </div>
        <GoToPopover v-if="goToOpen && goToButton" :anchor="goToButton" @close="closeGoTo">
            <GoToList :current="goToCurrent" @pick="onGoToPick" />
        </GoToPopover>
    </div>
</template>

<style scoped>
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
