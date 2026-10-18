<script setup lang="ts">
import { computed, nextTick, useTemplateRef, watch } from 'vue'
import { i18n } from '../../i18n'
import BaseModal from '../../modals/BaseModal.vue'
import { interpolate } from '../../utils/interpolate'
import { formatSize } from '../commands/exportLevel/format'
import type { PreparingModel } from './dialogs'

// The default "Preparing coconut.nxsp…" dialog (Part 1 §1.4.7): Cancel, and once the build
// outlasted the press, [Download] or [Save] as the new gesture. The Save UI package replaces it.
const props = defineProps<{ name: string; model: PreparingModel }>()

const emit = defineEmits<{ close: [go: boolean] }>()

const readyButton = useTemplateRef<HTMLButtonElement>('readyButton')

const text = computed(() =>
    interpolate(
        () => i18n.value.save.preparing,
        props.name,
        props.model.size ? formatSize(props.model.size) : '',
    )().trim(),
)

watch(
    () => props.model.ready,
    async (ready) => {
        if (!ready) return
        await nextTick()
        readyButton.value?.focus()
    },
)
watch(
    () => props.model.closed,
    (closed) => {
        if (closed) emit('close', false)
    },
)

const buttonClass =
    'h-9 min-w-24 rounded-full px-4 shadow-md outline-none transition-colors hover:shadow-accent focus-visible:ring-2 focus-visible:ring-fg [@media(pointer:coarse)]:h-11'
</script>

<template>
    <BaseModal :title="i18n.commands.save.title" @close="emit('close', false)">
        <p data-save-preparing>{{ text }}</p>
        <progress
            v-if="model.importing"
            class="w-full"
            :max="model.importing.total"
            :value="model.importing.done"
        />
        <div class="flex justify-end gap-2">
            <button
                type="button"
                class="bg-button active:bg-accent active:text-on-accent"
                :class="buttonClass"
                @click="emit('close', false)"
            >
                {{ i18n.modals.confirm.cancel }}
            </button>
            <button
                v-if="model.ready"
                ref="readyButton"
                type="button"
                class="bg-accent text-on-accent active:bg-button active:text-fg"
                :class="buttonClass"
                @click="emit('close', true)"
            >
                {{ model.ready === 'download' ? i18n.save.download : i18n.commands.save.title }}
            </button>
        </div>
    </BaseModal>
</template>
