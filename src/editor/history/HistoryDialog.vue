<script setup lang="ts">
import {
    computed,
    inject,
    nextTick,
    onBeforeUnmount,
    onMounted,
    useId,
    useTemplateRef,
    watch,
} from 'vue'
import { displayedPeekKey, peekedKey } from '../../history/peek'
import { isPeeking } from '../../history/stack'
import { i18n } from '../../i18n'
import { modalTitleKey } from '../../modals/title'
import { settings } from '../../settings'
import { isApplePlatform, matchBindings } from '../controls/bindings'
import HistoryPanel from './HistoryPanel.vue'
import type { HistoryCloseResult, HistoryPresentation } from './presentation'
import { peekedInfo, peekedSession } from './selection'

// The sheet and compact dialog share the panel's band and lists, without another title row.

const props = defineProps<{ presentation: HistoryPresentation }>()
const emit = defineEmits<{ close: [result?: HistoryCloseResult] }>()
const root = useTemplateRef<HTMLElement>('root')
const panel = useTemplateRef<{ rememberView: () => void; hasGoTo: () => boolean }>('panel')
const titleId = useId()

// The host names the dialog.
const modalTitle = inject(modalTitleKey, undefined)
if (modalTitle)
    watch(
        () => i18n.value.history.title,
        (title) => (modalTitle.value = title),
        { immediate: true },
    )

const canViewChart = computed(
    () =>
        isPeeking.value &&
        !!peekedKey.value &&
        (peekedInfo.value?.key === peekedKey.value ||
            peekedSession.value?.key === peekedKey.value) &&
        displayedPeekKey.value === peekedKey.value,
)
const captureView = () => {
    panel.value?.rememberView()
}
const viewChart = () => {
    if (!canViewChart.value) return
    captureView()
    emit('close', 'view-chart')
}
const onEscape = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return
    if (event.key !== 'Escape') {
        const target = event.target
        if (
            event.isComposing ||
            target instanceof HTMLInputElement ||
            target instanceof HTMLTextAreaElement ||
            (target instanceof HTMLElement && target.isContentEditable) ||
            event.repeat ||
            !matchBindings(
                { history: settings.keyboardShortcuts.history },
                event,
                isApplePlatform(),
            ).names.includes('history')
        )
            return
        event.preventDefault()
        event.stopPropagation()
        emit('close')
        return
    }
    event.preventDefault()
    event.stopPropagation()
    emit('close')
}
let dialog: HTMLDialogElement | null | undefined
let unregisterView: (() => void) | undefined
onMounted(() => {
    dialog = root.value?.closest('dialog')
    dialog?.addEventListener('keydown', onEscape)
    unregisterView = props.presentation.registerView(captureView)
    void nextTick(() => {
        if (!root.value?.isConnected) return
        const target = props.presentation.takeFocusTarget()
        const focused = target
            ? root.value.querySelector<HTMLElement>(`[data-history-focus="${target}"]`)
            : undefined
        if (panel.value?.hasGoTo()) return
        ;(
            focused ??
            root.value.querySelector<HTMLElement>('[data-history-list]') ??
            root.value.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
        )?.focus({ preventScroll: true })
    })
})
onBeforeUnmount(() => {
    dialog?.removeEventListener('keydown', onEscape)
    captureView()
    unregisterView?.()
})
</script>

<template>
    <div
        ref="root"
        class="flex h-full min-h-0 flex-col"
        :data-history-presentation="presentation.compact ? 'compact' : 'sheet'"
        @keydown="onEscape"
    >
        <span :id="titleId" class="sr-only" data-modal-title>{{ i18n.history.title }}</span>
        <HistoryPanel
            ref="panel"
            class="min-h-0 flex-1"
            surface="dialog"
            :presentation="presentation"
            @chrome="presentation.measureChrome"
            @close="emit('close')"
        />
        <div v-if="presentation.compact" class="flex shrink-0 justify-end p-4 pt-2">
            <button
                type="button"
                class="btn btn-secondary h-9 min-w-24 max-w-full truncate rounded-full px-4"
                :disabled="!canViewChart"
                data-history-view-chart
                data-history-focus="view-chart"
                @click="viewChart"
            >
                {{ i18n.history.viewChart }}
            </button>
        </div>
    </div>
</template>
