<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue'
import { startupGate } from '../startup/gate'
import { holdNotice, notification } from './notification'
import { hasToolModal, sheetBox, type ToolModalPane } from './toolModals'

// Shown within one editor pane, below its header (`inset`, in pixels), so it
// never covers the elevation header or straddles the split between panes.
const props = defineProps<{ pane: ToolModalPane; inset?: number }>()

// A tool dialog rises from the bottom of its pane, so notifications move to
// the top rather than fading over its fields. The History sheet is kept clear of instead: the
// notices stay above it, or beside it, so they never cover its list or the peek bar.
const sheet = computed(() => (props.pane === 'main' ? sheetBox.value : undefined))
const top = computed(() => hasToolModal(props.pane) && !sheet.value)

// A notice with an action sits above the floating toolbar, not where a tap on the chart lands.
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
    () => [notification.value.id, top.value],
    () => void nextTick(measure),
)

// A pointer that has not moved never enters a new pill, so its hover is taken here.
watch(
    () => notification.value.id,
    () => {
        const pill = host.value?.querySelector('.notification-pill')
        if (pill?.matches(':hover')) holdNotice('hover', true)
    },
    { flush: 'post' },
)

// The start-up pill waits for the startup gate to lift.
const shown = computed(
    () =>
        !!notification.value.message &&
        (!notification.value.startup || startupGate.phase === 'done'),
)

const pause = (source: 'hover' | 'focus', held: boolean) => {
    holdNotice(source, held)
}
</script>

<template>
    <!-- The page's one live region announces notices (NoticeHost); this only draws them. -->
    <div
        ref="host"
        class="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center px-2"
        :class="top ? 'items-start pt-4' : notification.action ? 'items-end' : 'items-center'"
        :style="{
            top: `${inset ?? 0}px`,
            paddingBottom:
                sheet?.side === 'bottom'
                    ? `${sheet.size + 2 * gap}px`
                    : !top && notification.action
                      ? `${clearance + gap}px`
                      : undefined,
            paddingRight: sheet?.side === 'right' ? `${sheet.size + 2 * gap}px` : undefined,
        }"
    >
        <div
            v-if="shown && !notification.action && !notification.held"
            :key="notification.id"
            class="notification whitespace-break-spaces rounded-full px-6 py-2 text-center"
        >
            {{ notification.message?.() }}
        </div>
        <div
            v-else-if="shown && notification.lines"
            :key="notification.id"
            class="notification notification-pill pointer-events-auto flex max-w-full flex-col gap-0.5 rounded-3xl py-1.5 shadow-md"
            :class="notification.action ? 'pl-5 pr-2' : 'px-5 text-center'"
            @pointerenter="pause('hover', true)"
            @pointerleave="pause('hover', false)"
            @focusin="pause('focus', true)"
            @focusout="pause('focus', false)"
        >
            <div
                v-for="(line, i) in notification.lines"
                :key="i"
                class="flex min-w-0 items-center gap-3"
            >
                <span class="min-w-0 flex-1 whitespace-break-spaces py-1">{{
                    line.message()
                }}</span>
                <button
                    v-if="line.action"
                    type="button"
                    data-notice-action
                    class="h-8 shrink-0 rounded-full bg-on-accent px-4 font-bold text-accent outline-none transition-colors focus-visible:ring-2 focus-visible:ring-on-accent focus-visible:ring-offset-2 focus-visible:ring-offset-accent [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:min-w-11"
                    @click="line.action.run()"
                >
                    {{ line.action.label() }}
                </button>
            </div>
        </div>
        <div
            v-else-if="shown"
            :key="notification.id"
            class="notification notification-pill pointer-events-auto flex max-w-full items-center gap-3 rounded-3xl py-1.5 pl-5 shadow-md"
            :class="notification.action ? 'pr-2' : 'pr-5 text-center'"
            @pointerenter="pause('hover', true)"
            @pointerleave="pause('hover', false)"
            @focusin="pause('focus', true)"
            @focusout="pause('focus', false)"
        >
            <span class="min-w-0 whitespace-break-spaces py-1">{{ notification.message?.() }}</span>
            <button
                v-if="notification.action"
                type="button"
                data-notice-action
                class="h-8 shrink-0 rounded-full bg-on-accent px-4 font-bold text-accent outline-none transition-colors focus-visible:ring-2 focus-visible:ring-on-accent focus-visible:ring-offset-2 focus-visible:ring-offset-accent [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:min-w-11"
                @click="notification.action?.run()"
            >
                {{ notification.action?.label() }}
            </button>
        </div>
    </div>
</template>

<style scoped>
.notification {
    animation-name: fade;
    animation-duration: 1s;
    animation-fill-mode: forwards;
}

/* Stays until its timeout ends, which removes it. */
.notification-pill {
    animation: none;
    /* Dark text on mint, as on every accent fill (8.9:1). */
    color: theme('colors.on-accent');
    background-color: theme('colors.accent');
    z-index: 100;
}

@keyframes fade {
    0% {
        z-index: 100;
        /* Dark text on mint, as on every accent fill (8.9:1). */
        color: theme('colors.on-accent');
        background-color: theme('colors.accent');
    }

    99% {
        z-index: 100;
    }

    100% {
        color: rgb(255 255 255 / 0.25);
        background-color: theme('colors.accent / 0%');
    }
}
</style>
