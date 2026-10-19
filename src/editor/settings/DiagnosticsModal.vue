<script setup lang="ts">
import { useTemplateRef } from 'vue'
import { i18n } from '../../i18n'
import BaseModal from '../../modals/BaseModal.vue'
import { notify } from '../notification'

const props = defineProps<{ text: string }>()

const emit = defineEmits<{
    close: []
}>()

const field = useTemplateRef<HTMLTextAreaElement>('field')

const copy = async () => {
    try {
        await navigator.clipboard.writeText(props.text)
    } catch {
        // Without clipboard access the text is selected, to copy by hand.
        field.value?.select()
        return
    }
    emit('close')
    notify(() => i18n.value.settings.about.copied)
}
</script>

<template>
    <BaseModal :title="i18n.settings.about.diagnosticsTitle" @close="emit('close')">
        <div>{{ i18n.settings.about.diagnosticsNote }}</div>

        <textarea
            ref="field"
            readonly
            rows="10"
            :value="text"
            class="focus-ring w-full resize-none rounded-lg bg-popup p-2 font-mono text-xs"
        />

        <div class="flex justify-end gap-2">
            <button
                type="button"
                class="btn btn-secondary h-9 min-w-24 max-w-full truncate rounded-full px-4"
                @click="emit('close')"
            >
                {{ i18n.modals.confirm.cancel }}
            </button>
            <button
                type="button"
                class="btn btn-primary h-9 min-w-24 max-w-full truncate rounded-full px-4"
                data-autofocus
                @click="copy"
            >
                {{ i18n.settings.about.copy }}
            </button>
        </div>
    </BaseModal>
</template>
