<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue'
import { startupGate } from '../startup/gate'
import { downArrowClearance } from './history/changes'
import NoticeCard from './NoticeCard.vue'
import { cardInDialog, holdNotice, noticeCard, notification, quickInDialog } from './notification'
import QuickNotice from './QuickNotice.vue'
import { hasToolModal, sheetBox, type ToolModalPane } from './toolModals'

// Shown within one editor pane, below its header (`inset`, in pixels), so it
// never covers the elevation header or straddles the split between panes.
const props = defineProps<{ pane: ToolModalPane; inset?: number }>()

// A tool dialog rises from the bottom of its pane, so notifications move to
// the top rather than fading over its fields. The History sheet is kept clear of instead: the
// notices stay above it, or beside it, so they never cover its list or the peek bar.
const sheet = computed(() => (props.pane === 'main' ? sheetBox.value : undefined))
const top = computed(() => hasToolModal(props.pane) && !sheet.value)

// A card sits above the floating toolbar, not where a tap on the chart lands; quick feedback is centred in the room above it.
const host = useTemplateRef<HTMLElement>('host')
const clearance = ref(0)
const gap = 8
let observer: ResizeObserver | undefined
let observed: Element | undefined
const measure = () => {
    const toolbar = host.value?.parentElement?.querySelector<HTMLElement>(
        ':scope > [data-editor-toolbar]',
    )
    const bar = toolbar?.firstElementChild
    // Observing again delivers a fresh notification at once, so only a new bar is observed.
    if (bar !== observed) {
        if (observed) observer?.unobserve(observed)
        observed = bar ?? undefined
        if (bar) observer?.observe(bar)
    }
    if (!toolbar || !bar) {
        clearance.value = 0
        return
    }
    // While a drag hides the toolbar its size reads 0: keep the last clearance.
    if (bar.getBoundingClientRect().height > 0) {
        const padding = parseFloat(getComputedStyle(toolbar).paddingBottom) || 0
        clearance.value = bar.getBoundingClientRect().height + padding
    }
}
onMounted(() => {
    observer = new ResizeObserver(measure)
    measure()
})
onBeforeUnmount(() => observer?.disconnect())
watch(
    () => [noticeCard.value?.id, top.value],
    () => void nextTick(measure),
)

// A pointer that has not moved never enters a new card, so its hover is taken here.
watch(
    () => noticeCard.value?.id,
    () => {
        const card = host.value?.querySelector('[data-notice-card]')
        if (card?.matches(':hover')) holdNotice('hover', true)
    },
    { flush: 'post' },
)

// The change view's down arrow sits at the chart's bottom edge; notices stay above it (the main pane only).
const arrowClear = computed(() => (props.pane === 'main' ? downArrowClearance.value : 0))

// The start-up notice waits for the startup gate to lift. What was raised over a blocking dialog shows there.
const quick = computed(() =>
    !!notification.value.message &&
    !quickInDialog.value &&
    (!notification.value.startup || startupGate.phase === 'done')
        ? notification.value
        : undefined,
)
const card = computed(() => {
    const notice = noticeCard.value
    if (!notice || cardInDialog.value) return undefined
    return !notice.startup || startupGate.phase === 'done' ? notice : undefined
})
</script>

<template>
    <!-- The page's one live region announces notices (NoticeHost); this only draws them. -->
    <div
        ref="host"
        class="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center px-2"
        :class="top ? 'justify-start gap-2 pt-4' : 'justify-end'"
        :style="{
            top: `${inset ?? 0}px`,
            paddingBottom:
                sheet?.side === 'bottom'
                    ? `${sheet.size + 2 * gap}px`
                    : !top && (card || arrowClear)
                      ? `${Math.max(card ? clearance : 0, arrowClear) + gap}px`
                      : undefined,
            paddingRight: sheet?.side === 'right' ? `${sheet.size + 2 * gap}px` : undefined,
        }"
    >
        <div
            v-if="quick"
            class="flex min-h-0 justify-center"
            :class="top ? '' : 'w-full flex-1 items-center'"
        >
            <QuickNotice :key="quick.id" :notice="quick" />
        </div>
        <NoticeCard v-if="card" :key="card.id" :notice="card" />
    </div>
</template>
