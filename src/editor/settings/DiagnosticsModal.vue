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
            class="w-full resize-none rounded-lg bg-popup p-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-fg"
        />

        <div class="flex justify-end gap-2">
            <button
                type="button"
                class="h-9 min-w-24 max-w-full truncate rounded-full bg-button px-4 shadow-md outline-none -outline-offset-2 transition-colors hover:shadow-accent focus-visible:ring-2 focus-visible:ring-fg active:bg-accent active:text-on-accent"
                @click="emit('close')"
            >
                {{ i18n.modals.confirm.cancel }}
            </button>
            <button
                type="button"
                class="h-9 min-w-24 max-w-full truncate rounded-full bg-accent px-4 text-on-accent shadow-md outline-none -outline-offset-2 transition-colors hover:shadow-accent focus-visible:ring-2 focus-visible:ring-fg active:bg-button active:text-fg"
                data-autofocus
                @click="copy"
            >
                {{ i18n.settings.about.copy }}
            </button>
        </div>
    </BaseModal>
</template>
