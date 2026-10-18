<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, useTemplateRef, watch } from 'vue'
import { isAppActive } from '../../activity'
import { isPeeking } from '../../history/peek'
import { peekClearance, sheetBox } from '../toolModals'
import { view } from '../view'
import { changeBand } from './changes'

const anchor = useTemplateRef<HTMLElement>('anchor')
let resize: ResizeObserver | undefined
let children: MutationObserver | undefined
const observed = new Set<Element>()
let alive = false
let frame = 0
const cancelMeasure = () => {
    if (frame) cancelAnimationFrame(frame)
    frame = 0
}
const scheduleMeasure = () => {
    cancelMeasure()
    if (!alive || !isAppActive.value) return
    frame = requestAnimationFrame(measure)
}
const measure = () => {
    frame = 0
    if (!alive || !isAppActive.value) return
    const pane = anchor.value?.parentElement
    if (!pane) return
    const box = pane.getBoundingClientRect()
    const bar = pane.querySelector(':scope > [data-peek-bar]')
    const top = bar ? Math.max(0, bar.getBoundingClientRect().bottom - box.top) : 0
    const toolbar = pane.querySelector(':scope > [data-editor-toolbar]')?.firstElementChild
    const tools = toolbar?.getBoundingClientRect()
    let bottom = tools?.height ? Math.max(0, box.bottom - tools.top) : 0
    if (sheetBox.value?.side === 'bottom') bottom = Math.max(bottom, sheetBox.value.size + 8)
    peekClearance.value = top
    if (changeBand.value.top !== top || changeBand.value.bottom !== bottom)
        changeBand.value = { top, bottom }
}
const observe = () => {
    if (!alive) return
    const pane = anchor.value?.parentElement
    if (!pane) return
    const toolbar = pane.querySelector(':scope > [data-editor-toolbar]')
    const targets = new Set(
        [
            pane,
            pane.querySelector(':scope > [data-peek-bar]'),
            toolbar,
            toolbar?.firstElementChild,
        ].filter((element): element is Element => !!element),
    )
    for (const element of observed) {
        if (targets.has(element)) continue
        resize?.unobserve(element)
        observed.delete(element)
    }
    for (const element of targets) {
        if (observed.has(element)) continue
        resize?.observe(element)
        observed.add(element)
    }
    scheduleMeasure()
}

onMounted(() => {
    alive = true
    resize = new ResizeObserver(scheduleMeasure)
    children = new MutationObserver(observe)
    if (anchor.value?.parentElement)
        children.observe(anchor.value.parentElement, { childList: true })
    observe()
})
onBeforeUnmount(() => {
    alive = false
    cancelMeasure()
    resize?.disconnect()
    children?.disconnect()
    observed.clear()
    peekClearance.value = 0
    changeBand.value = { top: 0, bottom: 0 }
})
watch(
    isAppActive,
    (active) => {
        if (active) void nextTick(observe)
        else cancelMeasure()
    },
    { flush: 'sync' },
)
watch([isPeeking, sheetBox, () => view.w, () => view.h], () => void nextTick(observe))
</script>

<template><span ref="anchor" class="hidden" aria-hidden="true" /></template>
