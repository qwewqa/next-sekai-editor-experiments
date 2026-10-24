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
import { i18n } from '../../i18n'
import { focusLost } from '../../utils/focusFallback'
import { useRootFontSize } from '../useRootFontSize'
import ChevronIcon from '../workspace/ChevronIcon.vue'
import CloseIcon from '../workspace/CloseIcon.vue'
import GoToIcon from './GoToIcon.vue'
import GoToList from './GoToList.vue'
import GoToPopover from './GoToPopover.vue'
import { hereRangeText } from './editsHere'
import RecentSessionsTab from './RecentSessionsTab.vue'
import type { Target } from './source'
import {
    hereRange,
    historyFilter,
    historyTab,
    historyViewGeneration,
    type HistoryTab,
} from './state'
import TimelineList from './TimelineList.vue'
import type { GoToView, HistoryPresentation } from './presentation'

// The History panel, in a dock or in the dialog: one band with the two tabs,
// Timeline and Recent Sessions, and Go To; then the list. There is no action bar in it: the peek's
// controls are on the canvas, so the body is all list.

const props = withDefaults(
    defineProps<{ surface?: 'panel' | 'dialog'; presentation?: HistoryPresentation }>(),
    { surface: 'panel', presentation: undefined },
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

// --- The band: one 48 px line. Go To shows its label when it fits beside the tabs, else only its
// icon, and then the tabs step down to 14 px labels (the mode below). The dialog's × takes its share.
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

const goToPopover = useTemplateRef<{
    captureView: () => Pick<GoToView, 'top' | 'focus'>
    restoreScroll: () => void
}>('goToPopover')
const goToList = useTemplateRef<{ activeId: () => string | undefined }>('goToList')
const savedGoTo = shallowRef(props.presentation?.takeGoTo())
let goToGeneration = historyViewGeneration()
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
            goToGeneration,
        )
    },
})

// The band is one 48 px line at every width. Go To shows its label while the tabs keep whole labels
// beside it, else its icon; when even that leaves no room, the tabs step down to 14 px labels in
// tighter pills, and only then does Recent Sessions truncate. Measured once per language: the
// tabs’ labels at both sizes and Go To’s label (its pill is 64 px plus the label). The fixed sizes
// are px at the 16 px rem; k scales them with the root font size, as the classes do.
const fit = shallowRef<{ full: number; small: number; goTo: number; k: number }>()
const measureFit = () => {
    const host = band.value
    if (!host) return
    const box = document.createElement('div')
    box.setAttribute('aria-hidden', 'true')
    box.style.cssText =
        'position:absolute;left:0;top:0;visibility:hidden;pointer-events:none;white-space:nowrap'
    const widthOf = (text: string, css: string) => {
        const span = document.createElement('span')
        span.style.cssText = `position:absolute;${css}`
        span.textContent = text
        box.append(span)
        return span
    }
    const full = tabs.map((tab) => widthOf(title(tab), 'font-size:1rem;font-weight:700'))
    const small = tabs.map((tab) => widthOf(title(tab), 'font-size:0.875rem;font-weight:700'))
    const goTo = widthOf(i18n.value.history.goTo, 'font-size:0.875rem')
    const k = (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16) / 16
    host.append(box)
    const w = (span: HTMLElement) => span.getBoundingClientRect().width
    fit.value = {
        full: full.reduce((sum, span) => sum + 24 * k + w(span), 0),
        small: small.reduce((sum, span) => sum + 16 * k + w(span), 0),
        goTo: (64 + Math.min(112, w(goTo) / k)) * k,
        k,
    }
    box.remove()
}
onMounted(() => {
    measureFit()
    document.fonts.addEventListener('loadingdone', measureFit)
})
onBeforeUnmount(() => {
    document.fonts.removeEventListener('loadingdone', measureFit)
})
watch(() => i18n.value, measureFit, { flush: 'post' })
// The sizes are in px at the root font size they were measured at: a change measures them again.
watch(useRootFontSize(), measureFit, { flush: 'post' })
const mode = computed<'label' | 'icon' | 'small'>(() => {
    const f = fit.value
    const width = bandWidth.value
    if (!f || width === 0) return 'label'
    // The band's 6 px gutters, the 6 px gap before Go To, and in the dialog its gap and ×.
    const room = width - (12 + 6 + (props.surface === 'dialog' ? 42 : 0)) * f.k
    if (f.full + f.goTo <= room) return 'label'
    if (f.full + 36 * f.k <= room) return 'icon'
    return 'small'
})
// Timeline never truncates: it does not shrink, and Recent Sessions takes the shortfall to its
// 48 px floor. In the dialog's small band (a narrow sheet, about 300 px) that needs the band's
// chrome tighter; the tab list clips rather than overlap Go To where nothing was measured.
const tight = computed(() => mode.value === 'small' && props.surface === 'dialog')

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
watch(
    historyViewGeneration,
    () => {
        closeGoTo(false)
    },
    { flush: 'sync' },
)
watch(
    [historyFilter, hereRange],
    () => {
        savedGoTo.value = undefined
    },
    { flush: 'sync' },
)
// The piece at the top of the list is Go To's current one.
const goToCurrent = ref<Target | 'now' | undefined>(savedGoTo.value?.current)
const openGoTo = () => {
    goToGeneration = historyViewGeneration()
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

// Escape in the dialog closes it; a peek stays, and Back to Now ends it.
const onEscape = (event: KeyboardEvent) => {
    if (props.surface !== 'dialog' || event.defaultPrevented) return
    event.preventDefault()
    event.stopPropagation()
    emit('close')
}

// Show All goes with the banner: focus on it goes to the list, as a Go To pick's does.
const showAll = (event: MouseEvent) => {
    historyFilter.value = 'all'
    blurAfterPointer(event)
    if (event.currentTarget !== document.activeElement) return
    void nextTick(() => {
        if (focusLost()) timeline.value?.focus()
    })
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
        <!-- The band: 48 px, one line, the 6 px panel gutter. Pill-and-marker tabs at its start, as
             the Properties band's; Go To, a flat band control, at its end. The dialog's small band
             (a narrow sheet) closes its gaps to 2 px and its tab pills to 6 px a side, so
             Timeline stays whole beside Recent Sessions at its 48 px floor. -->
        <div
            ref="band"
            class="flex h-12 shrink-0 items-center bg-header px-1.5"
            :class="tight ? 'gap-0.5' : 'gap-1.5'"
            data-history-band
            :data-band-mode="mode"
        >
            <div
                ref="tablist"
                role="tablist"
                class="flex h-full min-w-0 self-stretch overflow-hidden"
                :aria-label="i18n.history.title"
            >
                <!-- The whole band height is the tab's hit; its pill carries hover, press and focus. -->
                <button
                    v-for="tab in tabs"
                    :id="tabId(tab)"
                    :key="tab"
                    type="button"
                    role="tab"
                    class="history-tab group flex h-full items-center font-bold text-fg outline-none"
                    :class="[
                        tab === 'sessions' ? 'min-w-12 shrink-[10000]' : 'shrink-0',
                        { 'history-tab-small': mode === 'small', 'history-tab-tight': tight },
                    ]"
                    :aria-selected="historyTab === tab"
                    :aria-controls="historyTab === tab ? panelId : undefined"
                    :tabindex="historyTab === tab ? 0 : -1"
                    :title="title(tab)"
                    :data-history-focus="`tab-${tab}`"
                    @click="(select(tab), blurAfterPointer($event))"
                    @keydown="onTabKeydown"
                >
                    <span
                        class="history-tab-pill flex h-9 min-w-0 max-w-full items-center rounded-full transition-colors"
                        :class="
                            mode === 'small' ? (tight ? 'px-1.5 text-sm' : 'px-2 text-sm') : 'px-3'
                        "
                        ><span class="history-tab-label relative min-w-0"
                            ><span class="block truncate">{{ title(tab) }}</span></span
                        ></span
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
                class="ghost ghost-band ml-auto flex h-9 shrink-0 items-center gap-1.5 rounded-full text-sm"
                :class="[
                    mode === 'label' ? 'px-3' : 'w-9 justify-center',
                    { invisible: !onTimeline },
                ]"
                :title="goToButtonTitle"
                :aria-label="i18n.history.goTo"
                data-history-goto-button
                data-history-focus="goto"
                @click="(toggleGoTo(), blurAfterPointer($event))"
                @keydown="onGoToKeydown"
            >
                <GoToIcon />
                <template v-if="mode === 'label'">
                    <span class="max-w-28 truncate">{{ i18n.history.goTo }}</span>
                    <ChevronIcon direction="down" />
                </template>
            </button>
            <button
                v-if="surface === 'dialog'"
                type="button"
                class="ghost ghost-band flex size-9 shrink-0 items-center justify-center rounded-full"
                :aria-label="i18n.modals.close"
                :title="i18n.modals.close"
                data-history-close
                data-history-focus="close"
                @click="emit('close')"
            >
                <CloseIcon class="size-4" />
            </button>
        </div>
        <!-- While filtering, a banner says so; Show All is the way back. Its text starts at the first
             tab label's 18 px, Show All ends on Go To's edge. -->
        <div
            v-if="onTimeline && filtered"
            ref="filterBanner"
            class="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-fg/15 pl-[1.125rem] pr-1.5 text-xs"
            data-history-filter-banner
        >
            <span class="min-w-0 truncate" :title="filterText">{{ filterText }}</span>
            <button
                type="button"
                class="btn btn-secondary relative flex h-8 shrink-0 items-center rounded-full px-4 text-sm before:absolute before:-inset-1"
                data-history-focus="show-all"
                @click="showAll"
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
            <RecentSessionsTab v-else :surface="props.surface" @close="emit('close')" />
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
/* The tab's pill is its face (the inner-face pattern on the band). */
@media (hover: hover) and (pointer: fine) {
    .history-tab:not([aria-selected='true']):not(:active):hover .history-tab-pill {
        @apply bg-band-hover;
    }
}

.history-tab:active .history-tab-pill {
    @apply bg-band-press text-fg-strong;
}

.history-tab-pill {
    outline: 2px solid transparent;
    outline-offset: -2px;
}

.history-tab:focus-visible .history-tab-pill {
    outline-color: currentColor;
    outline-offset: -4px;
}

/* The shown tab's 4 px bar sits flush with the band's lower edge, 8 px past its label: 12 px below a
   24 px label, 14 px below a 20 px one. */
.history-tab[aria-selected='true'] .history-tab-label::after {
    content: '';
    @apply pointer-events-none absolute -bottom-3 -left-2 -right-2 h-1 rounded-t-full bg-fg;
}

.history-tab-small[aria-selected='true'] .history-tab-label::after {
    @apply -bottom-3.5;
}

/* The bar spans the pill: 6 px past the label in the dialog's small band. */
.history-tab-tight[aria-selected='true'] .history-tab-label::after {
    @apply -left-1.5 -right-1.5;
}

@media (forced-colors: active) {
    .history-tab[aria-selected='true'] .history-tab-label::after {
        background-color: CanvasText;
    }
}
</style>
