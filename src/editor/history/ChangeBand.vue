<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, useTemplateRef, watch } from 'vue'
import { isPeeking } from '../../history/peek'
import { peekClearance, sheetBox } from '../toolModals'
import { view } from '../view'
import { changeBand } from './changes'

const anchor = useTemplateRef<HTMLElement>('anchor')
let resize: ResizeObserver | undefined
let children: MutationObserver | undefined
let frame = 0
const scheduleMeasure = () => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(measure)
}
const measure = () => {
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
    resize?.disconnect()
    const pane = anchor.value?.parentElement
    if (!pane) return
    for (const element of [
        pane,
        pane.querySelector(':scope > [data-peek-bar]'),
        pane.querySelector(':scope > [data-editor-toolbar]'),
    ])
        if (element) resize?.observe(element)
    measure()
}
onMounted(() => {
    resize = new ResizeObserver(scheduleMeasure)
    children = new MutationObserver(observe)
    if (anchor.value?.parentElement)
        children.observe(anchor.value.parentElement, { childList: true })
    observe()
})
onBeforeUnmount(() => {
    cancelAnimationFrame(frame)
    resize?.disconnect()
    children?.disconnect()
    peekClearance.value = 0
    changeBand.value = { top: 0, bottom: 0 }
})
watch([isPeeking, sheetBox, () => view.w, () => view.h], () => void nextTick(observe))
</script>

<template><span ref="anchor" class="hidden" aria-hidden="true" /></template>
