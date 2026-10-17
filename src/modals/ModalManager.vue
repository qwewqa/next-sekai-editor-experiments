<script setup lang="ts">
import { computed, onMounted, onUnmounted, shallowRef, watch } from 'vue'
import { closeModal, modals, type Modal } from '.'
import NoticeRegion from '../editor/NoticeRegion.vue'

const regularModals = computed(() => modals.filter((modal) => modal.presentation !== 'tool'))

// Large dialogs fit the visual viewport, which an on-screen keyboard shrinks.
const hasLarge = computed(() => regularModals.value.some((modal) => modal.size === 'large'))
const visible = shallowRef<Record<string, string>>()
const measureVisible = () => {
    const viewport = window.visualViewport
    if (!viewport) return
    const top = viewport.offsetTop
    const bottom = document.documentElement.clientHeight - top - viewport.height
    visible.value = {
        '--modal-top': `${top}px`,
        '--modal-bottom': `${Math.max(0, bottom)}px`,
        '--modal-room': `${viewport.height}px`,
    }
}
watch(
    hasLarge,
    (large, _, onCleanup) => {
        const viewport = window.visualViewport
        if (!large || !viewport) return
        measureVisible()
        viewport.addEventListener('resize', measureVisible)
        viewport.addEventListener('scroll', measureVisible)
        onCleanup(() => {
            viewport.removeEventListener('resize', measureVisible)
            viewport.removeEventListener('scroll', measureVisible)
        })
    },
    { immediate: true },
)

// A backdrop press while the content is busy, e.g. selecting rows, keeps it open.
let keepOpen = false
const onBackdropDown = (event: PointerEvent) => {
    const dialog = event.currentTarget as HTMLElement
    keepOpen = event.target === dialog && !!dialog.querySelector('[data-modal-busy]')
}

// Escape ends the busy task first, wherever focus is.
const onCancel = (event: Event) => {
    const busy = (event.currentTarget as HTMLElement).querySelector('[data-modal-busy]')
    if (!busy) return
    event.preventDefault()
    busy.dispatchEvent(new Event('modalcancel'))
}

const onClick = (event: MouseEvent, modal: Modal) => {
    if (event.target !== event.currentTarget) return
    if (keepOpen) {
        keepOpen = false
        return
    }

    closeModal(modal)
}

// Whether the input that opened a dialog was a pointer: a click or tap focuses
// the dialog itself, so no field shows a focus ring or summons the on-screen
// keyboard, while a keyboard open still lands on the first field.
let byPointer = false
const onPointerDown = () => (byPointer = true)
const onKeyDown = () => (byPointer = false)

onMounted(() => {
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown, true)
})
onUnmounted(() => {
    window.removeEventListener('pointerdown', onPointerDown, true)
    window.removeEventListener('keydown', onKeyDown, true)
})

const vOpen = {
    mounted(el: HTMLDialogElement) {
        const title = el.querySelector('[data-modal-title]')
        if (title) el.setAttribute('aria-labelledby', title.id)
        // The body's primary action always takes focus, as a confirm button must.
        const body = el.lastElementChild
        const primary = body?.querySelector<HTMLElement>('[data-autofocus]')
        const focusDialog = byPointer && !primary
        // Firefox hides a scripted focus ring after an earlier pointer open.
        const focusVisible = !byPointer
        el.toggleAttribute('autofocus', focusDialog)
        const focusDefault = () => {
            if (focusDialog) {
                el.focus({ preventScroll: true })
                return
            }
            // Otherwise its first field or button.
            const label = body?.querySelector('label')
            ;(primary ?? label?.control ?? label ?? body?.querySelector('button'))?.focus({
                focusVisible,
            })
        }
        el.showModal()
        // showModal lands on the first button, the close ×, so the default takes focus in the same
        // task, before a key can reach the ×.
        focusDefault()
        setTimeout(() => {
            // Focus lost to a node that moved is restored; one moved by a click or key stays.
            if (document.activeElement === document.body) focusDefault()
        }, 0)
    },
    // Closing first returns focus to the opener, as Escape does.
    beforeUnmount(el: HTMLDialogElement) {
        if (el.open) el.close()
    },
}
</script>

<template>
    <!-- An 8px inset from the viewport on every side, like docked dialogs, menus
    and the phone sheet, so rounded corners never meet the screen edge. -->
    <dialog
        v-for="modal in regularModals"
        :key="modal.id"
        v-open
        tabindex="-1"
        class="flex w-[calc(100%-1rem)] flex-col rounded-xl bg-modal text-fg shadow-xl outline-none backdrop:bg-scrim/75"
        :class="
            modal.size === 'large'
                ? 'modal-large max-h-none max-w-[40rem]'
                : 'max-h-[calc(100%-1rem)] max-w-2xl'
        "
        :style="modal.size === 'large' ? visible : undefined"
        :data-size="modal.size"
        @pointerdown="onBackdropDown"
        @click="onClick($event, modal)"
        @cancel="onCancel"
        @close="closeModal(modal)"
    >
        <!-- The page behind a dialog is inert, so each dialog carries a region; only the top one is reachable. -->
        <NoticeRegion />
        <component :is="modal.is" v-bind="modal.props" @close="closeModal(modal, $event)" />
    </dialog>
</template>

<style scoped>
/* A fixed height, so changing content never resizes it; full height on phones. */
.modal-large {
    --modal-height: calc(var(--modal-room, var(--viewport-height)) - 1rem);
    top: var(--modal-top, 0px);
    bottom: var(--modal-bottom, 0px);
    height: var(--modal-height);
}

@media (min-width: 640px) {
    .modal-large {
        height: min(var(--modal-height), 48rem);
    }
}
</style>
