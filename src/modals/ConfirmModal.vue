<script setup lang="ts">
import { computed } from 'vue'
import { i18n } from '../i18n'
import { useActivationGuard } from './activationGuard'
import BaseModal from './BaseModal.vue'

const props = defineProps<{
    title: () => string
    message: () => string
    /** The confirm button's label, e.g. naming the action; "Confirm" by default. */
    confirm?: () => string
    /** Confirming deletes something: the button is red, and Cancel is the default, right of it. */
    destructive?: boolean
}>()

const emit = defineEmits<{
    close: [result: boolean]
}>()

// Enter on a menu row opens this dialog with focus on its default button: a press within the first
// moments, or a held key, is not a choice. Closing (×, Esc, outside) stays unguarded.
const { accidental, onKeydown } = useActivationGuard()

const pick = (result: boolean) => {
    if (accidental()) return
    emit('close', result)
}

// A destructive confirm lists the action first, then Cancel, primary and focused, as a destructive
// choice does; any other lists Cancel, then the focused confirm.
const buttons = computed(() => {
    const cancel = {
        result: false,
        label: () => i18n.value.modals.confirm.cancel,
    }
    const confirm = {
        result: true,
        label: () => props.confirm?.() ?? i18n.value.modals.confirm.confirm,
    }
    return props.destructive
        ? [
              { ...confirm, class: 'btn-danger-quiet', focus: false },
              { ...cancel, class: 'btn-primary', focus: true },
          ]
        : [
              { ...cancel, class: 'btn-secondary', focus: false },
              { ...confirm, class: 'btn-primary', focus: true },
          ]
})
</script>

<template>
    <BaseModal :title="title()" @close="emit('close', false)">
        <div>{{ message() }}</div>

        <div class="flex justify-end gap-2" @keydown.capture="onKeydown">
            <button
                v-for="button in buttons"
                :key="String(button.result)"
                type="button"
                class="btn h-9 min-w-24 max-w-full truncate rounded-full px-4"
                :class="button.class"
                :data-autofocus="button.focus || undefined"
                @click="pick(button.result)"
            >
                {{ button.label() }}
            </button>
        </div>
    </BaseModal>
</template>
