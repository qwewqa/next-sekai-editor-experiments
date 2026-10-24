<script setup lang="ts">
import {
    computed,
    nextTick,
    onMounted,
    onUnmounted,
    provide,
    ref,
    useTemplateRef,
    watch,
    watchEffect,
} from 'vue'
import { closeModal, modals } from '../modals'
import { modalTitleKey } from '../modals/title'
import { toolName } from './tools/state'
import { getSheetGeometry } from './sheetGeometry'
import { peekClearance, sheetBox, type ToolModalPane } from './toolModals'
import { view } from './view'

const props = defineProps<{ pane: ToolModalPane }>()
const panel = useTemplateRef<HTMLDivElement>('panel')
const matching = computed(() =>
    modals.filter((modal) => modal.presentation === 'tool' && modal.pane === props.pane),
)
const current = computed(() => matching.value.at(-1))
// The History sheet: along the pane's bottom, or down its right side in a short, wide pane.
const sheet = computed(() => !!current.value?.sheet)
const geometry = computed(() =>
    getSheetGeometry({
        width: view.w,
        height: view.h,
        peekClearance: peekClearance.value,
        rem: parseFloat(getComputedStyle(document.documentElement).fontSize) || 16,
    }),
)
const sheetSide = computed(() => geometry.value.side)
const frame = computed(() =>
    !sheet.value
        ? 'inset-x-0 bottom-2 mx-auto max-h-[70%] w-[calc(100%-1rem)] max-w-md'
        : sheetSide.value === 'right'
          ? 'bottom-2 right-2 w-[min(22rem,62%)]'
          : 'inset-x-2 bottom-2 mx-auto h-[min(55%,30rem)] min-h-60 max-w-[40rem]',
)
const sheetStyle = computed(() => {
    if (!sheet.value) return undefined
    if (sheetSide.value === 'right') return { top: `${geometry.value.top}px` }
    if (peekClearance.value && view.h < 600)
        return {
            height: `${geometry.value.height}px`,
            minHeight: '144px',
        }
    return undefined
})
const label = ref('')
provide(modalTitleKey, label)

// Main tools of the pane's toolbar, which a dialog unmounts and Escape brings back.
const toolButtons = (pane: Element | null | undefined) => [
    ...(pane?.querySelectorAll<HTMLElement>('[data-editor-toolbar] > div > div > button') ?? []),
]

// A tool the keyboard used to open the dialog; pointer clicks leave tools unfocused. Any other
// control that had focus is kept as `openerElement`.
let opener: { pane: Element; index: number } | undefined
let openerElement: HTMLElement | undefined

// Read before any render unmounts the toolbar, or the dialog on close.
watch(
    current,
    (modal, previous) => {
        if (!modal) {
            if (previous && modals.some(({ id }) => id === previous.id)) return
            returnFocus()
            return
        }
        const active = document.activeElement
        const pane = active?.closest('[data-editor-toolbar]')?.parentElement
        // A dialog replacing another keeps its opener.
        if (pane && active instanceof HTMLElement)
            opener = { pane, index: toolButtons(pane).indexOf(active) }
        else if (!panel.value?.contains(active)) opener = undefined
        // A control outside the toolbar is the opener itself, when it has focus (not the page).
        if (!panel.value?.contains(active))
            openerElement =
                active instanceof HTMLElement && active !== document.body && !pane
                    ? active
                    : undefined
    },
    { flush: 'sync' },
)

watch(current, async (modal) => {
    if (!modal) return
    await nextTick()
    if (current.value !== modal) return
    if (!panel.value?.contains(document.activeElement)) panel.value?.focus({ preventScroll: true })
})
watch(toolName, () => {
    // A sheet stays while the tool changes.
    if (current.value && !current.value.sheet) closeModal(current.value)
})

// The notices keep clear of the sheet.
let sizeObserver: ResizeObserver | undefined
watchEffect((onCleanup) => {
    const element = panel.value
    if (!sheet.value || !element) return
    const side = sheetSide.value
    const measure = () => {
        sheetBox.value = {
            side,
            size: side === 'right' ? element.offsetWidth : element.offsetHeight,
        }
    }
    sizeObserver = new ResizeObserver(measure)
    sizeObserver.observe(element)
    measure()
    onCleanup(() => {
        sizeObserver?.disconnect()
        sheetBox.value = undefined
    })
})

// A closed dialog that held focus gives it back to the tool that opened it, or else to the chart.
let focusReturn: { pane: HTMLElement; index: number } | undefined
function returnFocus() {
    const pane = panel.value?.parentElement
    if (!panel.value?.contains(document.activeElement) || !(pane instanceof HTMLElement)) return
    focusReturn = { pane, index: opener?.pane === pane ? opener.index : -1 }
}

// After the render brings the toolbar back; a dialog replacing it keeps focus.
watch(
    current,
    (modal) => {
        const target = focusReturn
        focusReturn = undefined
        if (modal || !target?.pane.isConnected) return
        const element = openerElement
        openerElement = undefined
        // The tool that opened it; else the control that did, if still on screen; else the chart.
        const visible = element?.isConnected && element.getClientRects().length > 0
        ;(
            toolButtons(target.pane)[target.index] ??
            (visible ? element : undefined) ??
            target.pane
        ).focus({ preventScroll: true })
    },
    { flush: 'post' },
)

const onKeydown = (event: KeyboardEvent) => {
    const modal = current.value
    // An Escape already handled, such as one that stops selecting, keeps the dialog.
    if (event.key !== 'Escape' || event.defaultPrevented || !modal || modals.at(-1) !== modal)
        return
    event.preventDefault()
    event.stopImmediatePropagation()
    closeModal(modal)
}

onMounted(() => {
    window.addEventListener('keydown', onKeydown)
})
onUnmounted(() => {
    window.removeEventListener('keydown', onKeydown)
    for (const modal of matching.value) closeModal(modal)
})
</script>

<template>
    <div
        v-if="current"
        ref="panel"
        :style="sheetStyle"
        role="dialog"
        :aria-label="label"
        tabindex="-1"
        data-tool-dialog
        class="editor-tool-modal absolute z-30 flex flex-col overflow-hidden rounded-xl bg-modal text-fg shadow-xl outline-none ring-1 ring-fg/10"
        :class="frame"
        :data-sheet="sheet ? sheetSide : undefined"
        @keydown="onKeydown"
        @pointerdown.stop
        @mousedown.stop
        @touchstart.stop
        @wheel.stop
    >
        <component
            :is="current.is"
            :key="current.id"
            v-bind="current.props"
            @close="closeModal(current, $event)"
        />
    </div>
</template>
