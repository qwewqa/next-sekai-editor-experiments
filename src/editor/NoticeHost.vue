<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from 'vue'
import { onHistoryAction } from '../history/actions'
import { isBlockingModalOpen } from '../modals'
import { isComposingKey } from '../utils/composition'
import { isTextEntry } from './controls/keyboard'
import NoticeRegion from './NoticeRegion.vue'
import { cardInDialog, dismissCardForEdit, dismissNoticeCard, noticeCard } from './notification'

// Where focus was before Alt+N moved it into the card, for Escape to return it.
let returnTo: HTMLElement | undefined

// The card's first action, or its close button when it has none.
const cardButton = () =>
    document.querySelector<HTMLElement>('[data-notice-card] [data-notice-action]') ??
    document.querySelector<HTMLElement>('[data-notice-card] [data-notice-close]')

// Alt+N (Option+N on macOS, by code) focuses the latest card while it is shown (Part 1 §1.4.1).
// A text field and IME composition keep the key: Option+N is the dead key of "ñ".
const onKeydown = (event: KeyboardEvent) => {
    if (event.code !== 'KeyN' || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
        return
    // A <select> takes the key for type-ahead.
    const editing = (target: EventTarget | null) =>
        isTextEntry(target) || target instanceof HTMLSelectElement
    if (isComposingKey(event) || editing(event.target) || editing(document.activeElement)) return
    // A blocking dialog makes the page inert: only a card shown over it can be reached.
    if (!noticeCard.value || (isBlockingModalOpen.value && !cardInDialog.value)) return
    const button = cardButton()
    if (!button) return
    if (document.activeElement !== button)
        returnTo =
            document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    button.focus({ focusVisible: true })
    event.preventDefault()
    event.stopImmediatePropagation()
}

// Escape in the card closes it and gives focus back, and is not Deselect.
const onEscape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !(event.target instanceof Element)) return
    if (!event.target.closest('[data-notice-card]')) return
    event.preventDefault()
    event.stopImmediatePropagation()
    const back = returnTo
    returnTo = undefined
    dismissNoticeCard()
    if (back?.isConnected) back.focus()
    else if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
}

// Focus that left the card another way is not owed back.
const onFocusOut = (event: FocusEvent) => {
    if (!(event.target instanceof Element) || !event.target.closest('[data-notice-card]')) return
    const into = event.relatedTarget
    if (!(into instanceof Element && into.closest('[data-notice-card]'))) returnTo = undefined
}

// A card that goes (or is replaced) while it holds focus may fire no focusout: its return target
// goes with it, so a later card's Escape does not use it.
watch(
    () => noticeCard.value?.id,
    () => {
        returnTo = undefined
    },
    { flush: 'sync' },
)

onMounted(() => {
    window.addEventListener('keydown', onKeydown, true)
    window.addEventListener('keydown', onEscape, true)
    window.addEventListener('focusout', onFocusOut, true)
})
onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeydown, true)
    window.removeEventListener('keydown', onEscape, true)
    window.removeEventListener('focusout', onFocusOut, true)
})

// A card goes at the first edit after it (Part 1 §1.4.1, §1.4.3): a stack a new visit restored can
// already undo, so the action itself is what counts. A switch of session dismisses it elsewhere.
const stopWatching = onHistoryAction((action) => {
    if (action.kind === 'reset' || action.kind === 'save' || action.kind === 'export') return
    dismissCardForEdit()
})
onBeforeUnmount(stopWatching)
</script>

<template>
    <!-- The page's one polite live region: every notice is read once, however many panes show it.
    A blocking dialog makes the page inert, so the dialogs carry regions meanwhile. -->
    <NoticeRegion v-if="!isBlockingModalOpen" initial />
</template>
