<script setup lang="ts">
import {
    computed,
    nextTick,
    onBeforeUnmount,
    onMounted,
    ref,
    shallowRef,
    useId,
    useTemplateRef,
    watch,
} from 'vue'
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
import type { HistoryPresentation } from './presentation'

// The History panel (Part 1 §1.4.10), in a dock or in the dialog: one band with the two tabs,
// Timeline and Recent Sessions, and Go To; then the list. There is no action bar in it: the peek's
// controls are on the canvas (§1.4.11), so the body is all list.

const props = withDefaults(
    defineProps<{ surface?: 'panel' | 'dialog'; presentation?: HistoryPresentation }>(),
    { surface: 'panel' },
)
const emit = defineEmits<{ close: []; chrome: [height: number] }>()

const tabs: readonly HistoryTab[] = ['timeline', 'sessions']

const id = useId()
const tabId = (tab: HistoryTab) => `${id}-tab-${tab}`
const panelId = `${id}-panel`

const title = (tab: HistoryTab) =>
    tab === 'timeline' ? i18n.value.history.timeline : i18n.value.history.recentSessions

const band = useTemplateRef<HTMLElement>('band')
const filterBanner = useTemplateRef<HTMLElement>('filterBanner')
const tablist = useTemplateRef<HTMLElement>('tablist')
const goToButton = useTemplateRef<HTMLButtonElement>('goToButton')
// What the Timeline offers Go To.
type TimelineHandle = {
    focus: () => void
    jumpTo: (target: Target | 'now') => Promise<void>
    topEntry: () => Target | 'now'
    rememberView: () => void
}
const timeline = useTemplateRef<TimelineHandle>('timeline')

// --- The band: Go To shows its label when it fits beside the tabs, else only its icon, and in a
// dock too narrow even for that it takes a second line. The dialog's × takes its share.
const bandWidth = ref(0)
let observer: ResizeObserver | undefined
const measureChrome = () => {
    if (band.value) bandWidth.value = band.value.clientWidth
    emit(
        'chrome',
        (band.value?.getBoundingClientRect().height ?? 0) +
            (filterBanner.value?.getBoundingClientRect().height ?? 0),
    )
}
onMounted(() => {
    const element = band.value
    if (!element) return
    observer = new ResizeObserver(measureChrome)
    observer.observe(element)
    if (filterBanner.value) observer.observe(filterBanner.value)
    measureChrome()
})
onBeforeUnmount(() => observer?.disconnect())
watch(
    filterBanner,
    (element, previous) => {
        if (previous) observer?.unobserve(previous)
        if (element) observer?.observe(element)
        measureChrome()
    },
    { flush: 'post' },
)

const goToPopover = useTemplateRef<InstanceType<typeof GoToPopover>>('goToPopover')
const goToList = useTemplateRef<InstanceType<typeof GoToList>>('goToList')
const savedGoTo = shallowRef(props.presentation?.takeGoTo())
defineExpose({
    hasGoTo: () => goToOpen.value,
    rememberView: () => {
        timeline.value?.rememberView()
        props.presentation?.rememberGoTo(
            goToOpen.value
                ? {
                      current: goToCurrent.value,
                      activeId: goToList.value?.activeId(),
                      ...goToPopover.value?.captureView(),
                      top: goToPopover.value?.captureView().top ?? 0,
                  }
                : undefined,
        )
    },
})

const LABEL_FROM = 362
const ICON_FROM = 236
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
const goToOpen = ref(!!savedGoTo.value)
const closeGoTo = (restoreFocus: boolean) => {
    goToOpen.value = false
    savedGoTo.value = undefined
    if (restoreFocus) void nextTick(() => goToButton.value?.focus({ preventScroll: true }))
}
// The piece at the top of the list is Go To's current one.
const goToCurrent = ref<Target | 'now'>(savedGoTo.value?.current)
const openGoTo = () => {
    savedGoTo.value = undefined
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
    savedGoTo.value = undefined
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
        `flex h-7 items-center justify-center rounded-full text-sm transition-colors ${
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
                    :data-history-focus="`tab-${tab}`"
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
                class="flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-button text-sm shadow-md outline-none transition-colors hover:shadow-accent focus-visible:ring-2 focus-visible:ring-fg active:bg-accent active:text-on-accent"
                :class="[
                    mode === 'icon' ? 'w-8 justify-center' : 'pl-3 pr-2',
                    { invisible: !onTimeline },
                ]"
                :title="goToButtonTitle"
                :aria-label="i18n.history.goTo"
                data-history-goto-button
                data-history-focus="goto"
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
                class="flex size-9 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-band-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg active:bg-accent active:text-on-accent"
                :aria-label="i18n.modals.close"
                :title="i18n.modals.close"
                data-history-close
                data-history-focus="close"
                @click="emit('close')"
            >
                <CloseIcon class="size-4" />
            </button>
        </div>
        <!-- While filtering, a banner says so; Show All is the way back. -->
        <div
            v-if="onTimeline && filtered"
            ref="filterBanner"
            class="flex h-9 shrink-0 items-center justify-between border-b border-fg/15 pl-5 pr-2 text-xs"
            data-history-filter-banner
        >
            <span class="min-w-0 truncate">{{ filterText }}</span>
            <button
                type="button"
                class="flex h-7 shrink-0 items-center rounded-full bg-button px-3 font-bold shadow-md outline-none transition-colors hover:shadow-accent focus-visible:ring-2 focus-visible:ring-fg active:bg-accent active:text-on-accent"
                data-history-focus="show-all"
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
        <GoToPopover
            v-if="goToOpen && goToButton"
            ref="goToPopover"
            :anchor="goToButton"
            :restore="savedGoTo"
            @close="closeGoTo"
        >
            <GoToList
                ref="goToList"
                :current="goToCurrent"
                :restore-active-id="savedGoTo?.activeId"
                @pick="onGoToPick"
                @ready="goToPopover?.restoreScroll()"
            />
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
