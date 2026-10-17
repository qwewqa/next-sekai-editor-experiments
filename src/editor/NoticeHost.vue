<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from 'vue'
import { canUndo } from '../history/stack'
import { isBlockingModalOpen } from '../modals'
import { isComposingKey } from '../utils/composition'
import { isTextEntry } from './controls/keyboard'
import { announcementOf, clearNotification, notification } from './notification'

// Where focus was before Alt+N moved it to the notice's button, for Escape to return it.
let returnTo: HTMLElement | undefined

const actionButton = () => document.querySelector<HTMLElement>('[data-notice-action]')

// Alt+N (Option+N on macOS, by code) focuses the latest action notice while it is shown (Part 1 §1.4.1).
// A text field and IME composition keep the key: Option+N is the dead key of "ñ".
const onKeydown = (event: KeyboardEvent) => {
    if (event.code !== 'KeyN' || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
        return
    if (isComposingKey(event) || isTextEntry(event.target) || isTextEntry(document.activeElement))
        return
    if (isBlockingModalOpen.value || !notification.value.action) return
    const button = actionButton()
    if (!button) return
    if (document.activeElement !== button)
        returnTo =
            document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    button.focus({ focusVisible: true })
    event.preventDefault()
    event.stopImmediatePropagation()
}

// Escape on the button gives focus back, and is not Deselect.
const onEscape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !(event.target instanceof Element)) return
    if (!event.target.closest('[data-notice-action]')) return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (returnTo?.isConnected) returnTo.focus()
    else if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    returnTo = undefined
}

onMounted(() => {
    window.addEventListener('keydown', onKeydown, true)
    window.addEventListener('keydown', onEscape, true)
})
onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeydown, true)
    window.removeEventListener('keydown', onEscape, true)
})

// The start-up pill with actions goes at the first edit (Part 1 §1.4.3).
watch(canUndo, (can) => {
    if (can && notification.value.startup && (notification.value.action || notification.value.held))
        clearNotification()
})
</script>

<template>
    <!-- The page's one polite live region: every notice is read once, however many panes show it.
    The key makes a repeated message read again. -->
    <div role="status" class="sr-only" data-notice-region>
        <span :key="notification.id">{{ announcementOf(notification) }}</span>
    </div>
</template>
