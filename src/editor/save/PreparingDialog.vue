<script setup lang="ts">
import { computed, nextTick, onMounted, useId, useTemplateRef, watch } from 'vue'
import { i18n } from '../../i18n'
import BaseModal from '../../modals/BaseModal.vue'
import { interpolate } from '../../utils/interpolate'
import { formatSize } from '../../utils/size'
import WaitBar from '../workspace/WaitBar.vue'
import type { PreparingModel } from './dialogs'

// "Preparing coconut.nxsp… 12 MB", then "Ready: coconut.nxsp · 12 MB": one small surface for a build that is
// slow, or a Save waiting for an open's import. Cancel stops the Save; when the build has
// outlasted the press, its button becomes [Download] or [Save], focused, and that press is the
// gesture.
const props = defineProps<{ name: string; model: PreparingModel; kind?: 'save' | 'export' }>()

const emit = defineEmits<{ close: [go: boolean] }>()

const ids = useId()
const readyButton = useTemplateRef<HTMLButtonElement>('readyButton')

const text = computed(() =>
    interpolate(
        () => (props.model.ready ? i18n.value.save.ready : i18n.value.save.preparing),
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

const buttonClass = 'btn h-9 min-w-24 max-w-full truncate rounded-full px-4'
</script>

<template>
    <BaseModal
        :title="kind === 'export' ? i18n.export.title : i18n.commands.save.title"
        @close="emit('close', false)"
    >
        <div class="flex flex-col gap-2">
            <p :id="`${ids}-text`" data-save-preparing>{{ text }}</p>
            <WaitBar
                v-if="progress !== undefined"
                :value="progress"
                :labelledby="`${ids}-text`"
                data-save-progress
            />
        </div>
        <div class="flex justify-end gap-2">
            <button
                type="button"
                class="btn-secondary"
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
                class="btn-primary"
                :class="buttonClass"
                @click="emit('close', true)"
            >
                {{
                    model.ready === 'download'
                        ? i18n.save.download
                        : kind === 'export'
                          ? i18n.export.export
                          : i18n.commands.save.title
                }}
            </button>
        </div>
    </BaseModal>
</template>
