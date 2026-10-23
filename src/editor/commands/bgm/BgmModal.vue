<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowReactive, watch } from 'vue'
import { isPeeking, liveState } from '../../../history'
import { i18n } from '../../../i18n'
import { showModal } from '../../../modals'
import FileField from '../../../modals/form/FileField.vue'
import FormModal from '../../../modals/form/FormModal.vue'
import NumberField from '../../../modals/form/NumberField.vue'
import LoadingModal from '../../../modals/LoadingModal.vue'
import type { Bgm } from '../../../state/bgm'
import { formatTime } from '../../../utils/format'
import { releaseWaveform, type Waveform } from '../../../waveform'
import { bgmStatus } from '../../media/heldBgm'
import { downloadBgm } from './downloadBgm'
import type { PickedBgm } from '../../media/applyPick'
import { loadPickedBgm } from './loadPicked'

const props = defineProps<{
    bgm: Bgm
    file?: File
}>()

const emit = defineEmits<{
    close: [bgm?: Bgm]
}>()

// Drops float noise: 0.0041 s shows as 4.1 ms, not 4.1000000000000005.
const shownOffset = Number((props.bgm.offset * 1000).toPrecision(15))

const model = shallowReactive({
    ...props.bgm,
    offset: shownOffset,
})

let request: AbortController | undefined
let ownedWaveform: Waveform | undefined
// Whether a file was picked here: the dialog then shows that file, not the live BGM.
let picked = false

// The live BGM may get its audio while this is open (it is read back from storage after a
// reload). The dialog takes it, so confirming does not drop the audio.
watch(
    () => liveState.value.bgm,
    (live) => {
        if (picked || !live.buffer || live.meta !== props.bgm.meta || model.buffer) return
        model.buffer = live.buffer
        model.source = live.source
        model.waveform = live.waveform
    },
)

// A BGM nothing holds is said so; one that is held and still being decoded shows nothing yet.
const unheld = ref(false)
if (props.bgm.meta && !props.bgm.buffer) {
    const { hash, size } = props.bgm.meta
    void bgmStatus(hash, size).then((status) => {
        unheld.value = status === 'absent'
    })
}
const shownFile = computed(() =>
    model.buffer
        ? formatTime(model.buffer.duration)
        : unheld.value
          ? i18n.value.save.bgmNotLoaded
          : undefined,
)

// The live BGM's bytes, when this tab has them (not what was picked here).
const heldSource = computed(() => liveState.value.bgm.source)

const onClose = () => {
    request?.abort()
    emit('close')
}

onBeforeUnmount(() => {
    request?.abort()
    releaseWaveform(ownedWaveform)
})
// It edits the live BGM, so a chart change or a peek closes it.
watch([() => liveState.value.store, isPeeking], onClose, { flush: 'sync' })

const onSelect = (file: File) => {
    request?.abort()
    const current = new AbortController()
    request = current
    picked = true

    void showModal(LoadingModal, {
        title: () => i18n.value.commands.bgm.title,
        async *task(signal: AbortSignal) {
            const cancel = () => {
                current.abort()
            }
            signal.addEventListener('abort', cancel, { once: true })
            let loaded: PickedBgm | undefined
            let published = false
            try {
                loaded = yield* loadPickedBgm(
                    file,
                    () => current.signal.aborted || signal.aborted,
                    current.signal,
                )
                releaseWaveform(ownedWaveform)
                ownedWaveform = loaded.waveform
                model.filename = loaded.filename
                model.buffer = loaded.buffer
                model.waveform = loaded.waveform
                model.source = loaded.source
                model.meta = loaded.meta
                published = true
            } finally {
                signal.removeEventListener('abort', cancel)
                if (!published) releaseWaveform(loaded?.waveform)
                if (request === current) request = undefined
            }
        },
    })
}

if (props.file) {
    onSelect(props.file)
}

const onSubmit = () => {
    request?.abort()
    // Ownership passes to chart history only after the user confirms this BGM.
    ownedWaveform = undefined
    emit('close', {
        // eslint-disable-next-line @typescript-eslint/no-misused-spread
        ...model,
        // An untouched offset stays exact; 4.1 / 1000 would be 0.0040999999999999995.
        offset:
            model.offset === shownOffset
                ? props.bgm.offset
                : Number((model.offset / 1000).toPrecision(15)),
    })
}
</script>

<template>
    <FormModal :title="i18n.commands.bgm.title" @close="onClose" @submit="onSubmit">
        <FileField :label="i18n.commands.bgm.modal.file" :value="shownFile" @select="onSelect" />
        <NumberField v-model="model.offset" :label="i18n.commands.bgm.modal.offset" step="any" />
        <button
            class="btn btn-secondary w-full rounded-full px-4 py-1"
            type="button"
            :disabled="!heldSource"
            @click="downloadBgm(liveState.bgm)"
        >
            {{ i18n.commands.bgm.modal.download }}
        </button>
    </FormModal>
</template>
