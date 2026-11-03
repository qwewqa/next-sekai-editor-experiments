<script setup lang="ts">
import { computed, nextTick, onMounted, useId, useTemplateRef, watch } from 'vue'
import { i18n } from '../../i18n'
import BaseModal from '../../modals/BaseModal.vue'
import { inlineName } from '../../utils/inlineName'
import { interpolate } from '../../utils/interpolate'
import SeparatedText from '../SeparatedText.vue'
import { formatSize } from '../../utils/size'
import WaitBar from '../workspace/WaitBar.vue'
import type { PreparingKind, PreparingModel } from './dialogs'

// "Preparing coconut.nxsp… 12 MB", or "Ready: coconut.nxsp · 12 MB" once a build that outlasted
// the press is done: one small surface for a build that is slow, or a Save waiting for an open's
// import. Cancel stops the Save; when the build is ready, its button becomes [Download], [Save] or
// [Export], focused, and that press is the gesture. The bar slides while it works, and shows the
// import's fraction while a Save waits for one.
const props = defineProps<{ name: string; model: PreparingModel; kind?: PreparingKind }>()

const emit = defineEmits<{ close: [go: boolean] }>()

const ids = useId()
const readyButton = useTemplateRef<HTMLButtonElement>('readyButton')

const text = computed(() => {
    // A video has no size until it is written, so it shows Export Video's own lines.
    if (props.kind === 'video')
        return props.model.ready ? i18n.value.exportVideo.ready : i18n.value.exportVideo.preparing
    return interpolate(
        () => (props.model.ready ? i18n.value.save.ready : i18n.value.save.preparing),
        inlineName(props.name),
        props.model.size ? formatSize(props.model.size) : '',
    )().trim()
})

const labels = computed(() => {
    const { value } = i18n
    switch (props.kind) {
        case 'video':
            return { title: value.exportVideo.title, press: value.exportVideo.exportNow }
        case 'export':
            return { title: value.export.title, press: value.export.export }
        case 'save':
        case undefined:
            return { title: value.commands.save.title, press: value.commands.save.title }
    }
})

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
    <BaseModal :title="labels.title" @close="emit('close', false)">
        <div class="flex flex-col gap-2">
            <p :id="`${ids}-text`" class="[overflow-wrap:anywhere]" data-save-preparing>
                <SeparatedText :text="text" />
            </p>
            <WaitBar
                v-if="!model.ready"
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
                {{ model.ready === 'download' ? i18n.save.download : labels.press }}
            </button>
        </div>
    </BaseModal>
</template>
