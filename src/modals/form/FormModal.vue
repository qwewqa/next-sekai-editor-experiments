<script setup lang="ts">
import { provide, useSlots } from 'vue'
import { i18n } from '../../i18n'
import BaseModal from '../BaseModal.vue'
import { stackLongValuesKey } from './fieldLayout'

// Long values go below their label, as in Settings.
provide(stackLongValuesKey, true)

const slots = useSlots()

defineProps<{
    title: string
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

            <!-- With extra actions, a phone stacks them as the choice dialogs do: Confirm on top. -->
            <div
                class="mt-4 flex flex-wrap justify-end gap-2"
                :class="
                    slots.actions
                        ? 'max-[480px]:flex-col-reverse max-[480px]:[&>*]:w-full'
                        : undefined
                "
            >
                <slot name="actions" />
                <input
                    class="btn btn-primary h-9 min-w-24 max-w-full truncate rounded-full px-4"
                    type="submit"
                    :value="i18n.modals.form.confirm"
                />
            </div>
        </form>
    </BaseModal>
</template>
