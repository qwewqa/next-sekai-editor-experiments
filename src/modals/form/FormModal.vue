<script setup lang="ts">
import { provide } from 'vue'
import { i18n } from '../../i18n'
import BaseModal from '../BaseModal.vue'
import { stackLongValuesKey } from './fieldLayout'

// Long values go below their label, as in Settings.
provide(stackLongValuesKey, true)

defineProps<{
    title: string
    submitLabel?: string
}>()

defineEmits<{
    submit: []
    close: []
}>()
</script>

<template>
    <BaseModal :title @close="$emit('close')">
        <form @submit.prevent="$emit('submit')">
            <div class="flex flex-col gap-3">
                <slot />
            </div>

            <div class="mt-4 flex justify-end">
                <input
                    class="btn btn-primary h-9 min-w-24 max-w-full truncate rounded-full px-4"
                    type="submit"
                    :value="submitLabel ?? i18n.modals.form.confirm"
                />
            </div>
        </form>
    </BaseModal>
</template>
