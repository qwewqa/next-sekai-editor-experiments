<script setup lang="ts">
import { computed, onMounted, onUnmounted, shallowRef, watch } from 'vue'
import { closeModal, modals, type Modal } from '.'
import NoticeCard from '../editor/NoticeCard.vue'
import { cardInDialog, noticeCard, notification, quickInDialog } from '../editor/notification'
import NoticeRegion from '../editor/NoticeRegion.vue'
import QuickNotice from '../editor/QuickNotice.vue'

const regularModals = computed(() => modals.filter((modal) => modal.presentation !== 'tool'))

// A notice raised while a dialog is open shows over the top dialog.
const overModal = computed(() => regularModals.value.at(-1))

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
const largeStyle = (modal: Modal) => ({ ...visible.value, '--modal-cap': modal.cap })
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

// A click on the dialog element itself is a backdrop click only when the press began and ended
// on the backdrop. A press that starts in the content and is released over the backdrop, such as
// selecting text in a field, is dispatched to the dialog too, and must not close it.
let downOnBackdrop = false
let upOnBackdrop = false
// A backdrop press while the content is busy, e.g. selecting rows, keeps it open.
let keepOpen = false
const onBackdropDown = (event: PointerEvent) => {
    if (!event.isPrimary) return
    const dialog = event.currentTarget as HTMLElement
    downOnBackdrop = event.target === dialog
    upOnBackdrop = false
    keepOpen = downOnBackdrop && !!dialog.querySelector('[data-modal-busy]')
}
const onBackdropUp = (event: PointerEvent) => {
    if (!event.isPrimary) return
    upOnBackdrop = event.target === event.currentTarget
}

// Escape ends the busy task first, wherever focus is.
const onCancel = (event: Event, modal: Modal) => {
    const busy = (event.currentTarget as HTMLElement).querySelector('[data-modal-busy]')
    if (busy) {
        event.preventDefault()
        busy.dispatchEvent(new Event('modalcancel'))
    }
    // A cancel not refused closes the dialog (with no user activation even a busy one's is not
    // refusable). It leaves the stack now, as a button's close does: the close event comes a task
    // later, and a key pressed meanwhile must reach the editor.
    if (!event.defaultPrevented) closeModal(modal)
}

const onClick = (event: MouseEvent, modal: Modal) => {
    if (event.target !== event.currentTarget) return
    const backdrop = downOnBackdrop && upOnBackdrop
    downOnBackdrop = false
    upOnBackdrop = false
    if (!backdrop) {
        keepOpen = false
        return
    }
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
        const body = [...el.children]
            .filter((child) => !child.hasAttribute('data-notice-layer'))
            .pop()
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
            const target = primary ?? label?.control ?? label ?? body?.querySelector('button')
            target?.focus({ focusVisible })
            // A prefilled name is selected, so typing replaces it.
            if (target instanceof HTMLInputElement && target.type === 'text') target.select()
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
                ? ['modal-large max-h-none', modal.tall ? 'max-w-2xl' : 'max-w-[40rem]']
                : 'max-h-[calc(100%-1rem)] max-w-2xl'
        "
        :style="modal.size === 'large' ? largeStyle(modal) : undefined"
        :data-size="modal.size"
        :data-tall="modal.tall || undefined"
        @pointerdown.capture="onBackdropDown"
        @pointerup.capture="onBackdropUp"
        @click="onClick($event, modal)"
        @cancel="onCancel($event, modal)"
        @close="closeModal(modal)"
    >
        <!-- The page behind a dialog is inert, so each dialog carries a region; only the top one is reachable. -->
        <NoticeRegion />
        <component :is="modal.is" v-bind="modal.props" @close="closeModal(modal, $event)" />
        <div
            v-if="
                modal === overModal &&
                ((quickInDialog && notification.message) || (cardInDialog && noticeCard))
            "
            data-notice-layer
            class="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 px-2 pb-4"
        >
            <QuickNotice
                v-if="quickInDialog && notification.message"
                :key="notification.id"
                :notice="notification"
            />
            <NoticeCard
                v-if="cardInDialog && noticeCard"
                :key="noticeCard.id"
                :notice="noticeCard"
                over
            />
        </div>
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

/* A tall dialog keeps the full height at every width. */
@media (min-width: 640px) {
    .modal-large:not([data-tall]) {
        height: min(var(--modal-height), var(--modal-cap, 48rem));
    }
}
</style>
