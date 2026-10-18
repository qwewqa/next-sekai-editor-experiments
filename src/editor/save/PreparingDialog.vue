<script setup lang="ts">
import { computed, nextTick, onMounted, useId, useTemplateRef, watch } from 'vue'
import { i18n } from '../../i18n'
import BaseModal from '../../modals/BaseModal.vue'
import { interpolate } from '../../utils/interpolate'
import { formatSize } from '../../utils/size'
import type { PreparingModel } from './dialogs'

// "Preparing coconut.nxsp… 12 MB" (Part 1 §1.4.7, §1.5.6): one small surface for a build that is
// slow, or a Save waiting for an open's import. Cancel stops the Save; when the build has
// outlasted the press, its button becomes [Download] or [Save], focused, and that press is the
// gesture.
const props = defineProps<{ name: string; model: PreparingModel }>()

const emit = defineEmits<{ close: [go: boolean] }>()

const ids = useId()
const readyButton = useTemplateRef<HTMLButtonElement>('readyButton')

const text = computed(() =>
    interpolate(
        () => i18n.value.save.preparing,
        props.name,
        props.model.size ? formatSize(props.model.size) : '',
    )().trim(),
)

const progress = computed(() => {
    const importing = props.model.importing
    return importing && importing.total > 0
        ? Math.min(100, Math.round((importing.done / importing.total) * 100))
        : undefined
})

const focusReady = async () => {
    await nextTick()
    readyButton.value?.focus()
}
watch(
    () => props.model.ready,
    (ready) => {
        if (ready) void focusReady()
    },
)
onMounted(() => {
    if (props.model.ready) void focusReady()
})
watch(
    () => props.model.closed,
    (closed) => {
        if (closed) emit('close', false)
    },
)

const buttonClass =
    'h-9 min-w-24 max-w-full truncate rounded-full px-4 shadow-md outline-none -outline-offset-2 transition-colors hover:shadow-accent focus-visible:ring-2 focus-visible:ring-fg [@media(pointer:coarse)]:h-11'
</script>

<template>
    <BaseModal :title="i18n.commands.save.title" @close="emit('close', false)">
        <div class="flex flex-col gap-2">
            <p :id="`${ids}-text`" data-save-preparing>{{ text }}</p>
            <div
                v-if="progress !== undefined"
                class="h-1 overflow-hidden rounded-full bg-fg/20"
                role="progressbar"
                :aria-labelledby="`${ids}-text`"
                aria-valuemin="0"
                aria-valuemax="100"
                :aria-valuenow="progress"
                data-save-progress
            >
                <div class="h-full rounded-full bg-fg" :style="{ width: `${progress}%` }" />
            </div>
        </div>
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
                :aria-describedby="`${ids}-text`"
                class="bg-accent text-on-accent active:bg-button active:text-fg"
                :class="buttonClass"
                @click="emit('close', true)"
            >
                {{ model.ready === 'download' ? i18n.save.download : i18n.commands.save.title }}
            </button>
        </div>
    </BaseModal>
</template>
