<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue'
import { holdNotice, notification } from './notification'
import { hasToolModal, type ToolModalPane } from './toolModals'

// Shown within one editor pane, below its header (`inset`, in pixels), so it
// never covers the elevation header or straddles the split between panes.
const props = defineProps<{ pane: ToolModalPane; inset?: number }>()

// A tool dialog rises from the bottom of its pane, so notifications move to
// the top rather than fading over its fields.
const top = computed(() => hasToolModal(props.pane))

// A notice with an action sits above the floating toolbar, not where a tap on the chart lands.
const host = useTemplateRef<HTMLElement>('host')
const clearance = ref(0)
const gap = 8
let observer: ResizeObserver | undefined
const measure = () => {
    const toolbar = host.value?.parentElement?.querySelector<HTMLElement>(
        ':scope > [data-editor-toolbar]',
    )
    const bar = toolbar?.firstElementChild
    observer?.disconnect()
    if (!toolbar || !bar) {
        clearance.value = 0
        return
    }
    observer?.observe(bar)
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
            paddingBottom: !top && notification.action ? `${clearance + gap}px` : undefined,
        }"
    >
        <div
            v-if="notification.message && !notification.action"
            :key="notification.id"
            class="notification whitespace-break-spaces rounded-full px-6 py-2 text-center"
        >
            {{ notification.message() }}
        </div>
        <Transition name="notice-pill">
            <div
                v-if="notification.message && notification.action"
                :key="notification.id"
                class="notification notification-pill pointer-events-auto flex max-w-full items-center gap-3 rounded-3xl py-1.5 pl-5 pr-2 shadow-md"
                @pointerenter="pause('hover', true)"
                @pointerleave="pause('hover', false)"
                @focusin="pause('focus', true)"
                @focusout="pause('focus', false)"
            >
                <span class="min-w-0 whitespace-break-spaces py-1">{{
                    notification.message()
                }}</span>
                <button
                    type="button"
                    data-notice-action
                    class="h-8 shrink-0 rounded-full bg-on-accent px-4 font-bold text-accent outline-none transition-colors focus-visible:ring-2 focus-visible:ring-on-accent focus-visible:ring-offset-2 focus-visible:ring-offset-accent [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:min-w-11"
                    @click="notification.action?.run()"
                >
                    {{ notification.action?.label() }}
                </button>
            </div>
        </Transition>
    </div>
</template>

<style scoped>
.notification {
    animation-name: fade;
    animation-duration: 1s;
    animation-fill-mode: forwards;
}

/* Stays until its timeout ends, which removes it. */
.notice-pill-leave-active {
    transition: opacity 0.2s;
}

.notice-pill-leave-to {
    opacity: 0;
}

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
