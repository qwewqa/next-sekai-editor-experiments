<script setup lang="ts">
import { i18n } from '../i18n'
import { useActivationGuard } from './activationGuard'
import BaseModal from './BaseModal.vue'

defineProps<{
    title: () => string
    message: () => string
    /** The confirm button's label, e.g. naming the action; "Confirm" by default. */
    confirm?: () => string
    /** Confirming deletes something: the button is red. */
    destructive?: boolean
}>()

const emit = defineEmits<{
    close: [result: boolean]
}>()

// Enter on a menu row opens this dialog with focus on the confirm button: a press within the first
// moments, or a held key, is not a choice. Closing (×, Esc, outside) stays unguarded.
const { accidental, onKeydown } = useActivationGuard()

const pick = (result: boolean) => {
    if (accidental()) return
    emit('close', result)
}
</script>

<template>
    <BaseModal :title="title()" @close="emit('close', false)">
        <div>{{ message() }}</div>

        <div class="flex justify-end gap-2" @keydown.capture="onKeydown">
            <button
                type="button"
                class="btn btn-secondary h-9 min-w-24 max-w-full truncate rounded-full px-4"
                @click="pick(false)"
            >
                {{ i18n.modals.confirm.cancel }}
            </button>
            <button
                type="button"
                class="btn h-9 min-w-24 max-w-full truncate rounded-full px-4"
                :class="destructive ? 'btn-danger' : 'btn-primary'"
                data-autofocus
                @click="pick(true)"
            >
                {{ confirm?.() ?? i18n.modals.confirm.confirm }}
            </button>
        </div>
    </BaseModal>
</template>
