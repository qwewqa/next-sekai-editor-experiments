<script setup lang="ts">
import { computed, onBeforeUnmount, provide, ref, shallowReactive, useId, watch } from 'vue'
import { i18n } from '../../../i18n'
import { showModal } from '../../../modals'
import BaseModal from '../../../modals/BaseModal.vue'
import { showChoice } from '../../../modals/choice'
import BaseField from '../../../modals/form/BaseField.vue'
import { stackLongValuesKey } from '../../../modals/form/fieldLayout'
import NumberField from '../../../modals/form/NumberField.vue'
import OptionalNumberField from '../../../modals/form/OptionalNumberField.vue'
import OptionalTextField from '../../../modals/form/OptionalTextField.vue'
import TextAreaField from '../../../modals/form/TextAreaField.vue'
import LoadingModal from '../../../modals/LoadingModal.vue'
import { pickFile } from '../../../utils/file'
import { inlineName } from '../../../utils/inlineName'
import { runCommand } from '../runCommand'
import { statusText } from '../../labelText'
import { peekedSession } from '../../history/selection'
import { stopPlayer } from '../../player'
import { changedFields, type Draft } from '../../levelInfo/draft'
import { trackHeldPicks } from '../../levelInfo/heldPicks'
import MediaRow from '../../levelInfo/MediaRow.vue'
import {
    attachPicked,
    capturePicked,
    type MediaSlot,
    type Picked,
    type Source,
} from '../../levelInfo/picked'
import {
    editCover as openCoverEditor,
    makePreview as openPreviewEditor,
} from '../../levelInfo/utilities'
import { useMedia } from '../../levelInfo/useMedia'
import { checkProject } from '../checkProject'
import PlayIcon from '../play/PlayIcon.vue'
import StopIcon from '../stop/StopIcon.vue'

// Level Info: one form for the level's identity text,
// Cover, Preview Audio and Initial Life. It keeps a draft, and Confirm hands it to the command,
// which makes one step of the fields that changed. Cover Editor and Preview Editor open over it and return their result to the draft.

const props = defineProps<{
    /** The values the form opened with, which Apply compares the draft against. */
    opening: Draft
    /** While peeking: shown, not changed. */
    readOnly?: boolean
}>()

const emit = defineEmits<{
    close: [draft?: Draft]
}>()

// Long values go below their label, as in Settings.
provide(stackLongValuesKey, true)

// Shallow: a picked file's record goes into a step as it is, and a reactive proxy of it cannot be
// cloned to the storage worker.
const draft = shallowReactive<Draft>({ ...props.opening })
const dirty = computed(() => changedFields(props.opening, draft).length > 0)

// --- Picks held for this dialog. A pick the tab did not hold before stays held only while the
// draft or the opening values name it, or after Apply; the rest is released.
const picks = trackHeldPicks()
const inUse = (hash: string) =>
    [props.opening, draft].some((each) => each.cover?.hash === hash || each.preview?.hash === hash)
watch(
    () => [draft.cover?.hash, draft.preview?.hash],
    () => {
        picks.release(inUse)
    },
)
// Closed without Apply: every unused pick goes. After Apply the set is empty.
onBeforeUnmount(() => {
    picks.release(
        (hash) => props.opening.cover?.hash === hash || props.opening.preview?.hash === hash,
    )
})

// --- Leaving: with changes, asks first. Escape reaches `modalcancel` while the form is "busy".
let asking = false
const askDiscard = async () => {
    if (asking) return
    asking = true
    const discard = await showChoice({
        title: () => i18n.value.levelInfo.discard,
        choices: [
            {
                value: true,
                label: () => i18n.value.settings.localData.discardConfirm,
                danger: true,
            },
        ],
        cancelIsDefault: true,
        cancelLabel: () => i18n.value.conflict.keepEditing,
    })
    asking = false
    if (discard) emit('close')
}
const leave = () => {
    if (!props.readOnly && dirty.value) void askDiscard()
    else emit('close')
}

const submit = () => {
    if (props.readOnly) emit('close')
    else {
        // The step that names the picks is made from this draft, which keeps their bytes held.
        picks.applied()
        // A plain copy: the form's own object is reactive.
        // eslint-disable-next-line @typescript-eslint/no-misused-spread
        emit('close', { ...draft })
    }
}

// --- The file line and Check.
const fileLine = statusText
const fileId = useId()
const check = () => {
    void runCommand(checkProject, 'button')
}

// --- Cover.
const cover = useMedia(() => draft.cover)
const coverLine = computed(() =>
    draft.cover
        ? inlineName(draft.cover.filename) || i18n.value.historyChanges.fields.cover
        : i18n.value.modals.form.notSet,
)

// --- Preview Audio.
const preview = useMedia(() => draft.preview)
const previewLine = computed(() => {
    const ref = draft.preview
    if (!ref) return i18n.value.modals.form.notSet
    const name = inlineName(ref.filename) || i18n.value.historyChanges.fields.previewAudio
    return preview.status.value === 'absent' ? `${name} · ${i18n.value.levelInfo.notLoaded}` : name
})

let audio: HTMLAudioElement | undefined
const playing = ref(false)
const stopPlaying = () => {
    audio?.pause()
    audio = undefined
    playing.value = false
}
const togglePlay = async () => {
    if (playing.value) {
        stopPlaying()
        return
    }
    const url = preview.url.value
    if (!url) return
    // Otherwise the chart would keep playing under the clip.
    stopPlayer(false)
    const element = new Audio(url)
    audio = element
    playing.value = true
    element.addEventListener('ended', () => {
        if (audio === element) stopPlaying()
    })
    try {
        await element.play()
    } catch {
        if (audio === element) stopPlaying()
    }
}
// Another item or none is not what was playing.
watch(() => preview.url.value, stopPlaying)
onBeforeUnmount(stopPlaying)

// --- Picks. A file is checked and held in a loading dialog; the draft takes it when that ends.
const slotTitle = (slot: MediaSlot) =>
    slot === 'cover'
        ? i18n.value.historyChanges.fields.cover
        : i18n.value.historyChanges.fields.previewAudio

const take = async (slot: MediaSlot, source: Source) => {
    const result: { picked?: Picked } = {}
    await showModal(LoadingModal, {
        title: () => slotTitle(slot),
        async *task() {
            yield () => i18n.value.modals.loading.loading
            result.picked = await capturePicked(slot, source)
        },
    })
    const { picked } = result
    if (!picked) return
    const media = slot === 'cover' ? cover : preview
    const named = draft[slot]
    // The file a "not loaded" slot names: stored again, nothing changes.
    if (named && media.status.value === 'absent' && picked.ref.hash === named.hash) {
        attachPicked(picked, named)
        picks.adopt(named.hash)
        void media.reload()
        return
    }
    picks.hold(picked)
    draft[slot] = picked.ref
}

const choose = async (slot: MediaSlot) => {
    const file = await pickFile()
    if (file) await take(slot, file)
}

const editCover = async () => {
    const image = cover.blob.value
    if (!image) return
    const made = await openCoverEditor(image)
    if (made)
        await take('cover', {
            name: made.filename,
            type: made.blob.type,
            arrayBuffer: () => made.blob.arrayBuffer(),
        })
}

const makePreview = async () => {
    const made = await openPreviewEditor()
    if (made)
        await take('preview', {
            name: made.filename,
            type: made.blob.type,
            arrayBuffer: () => made.blob.arrayBuffer(),
        })
}

const buttonClass = 'btn btn-secondary h-9 min-w-24 max-w-full truncate rounded-full px-4'
</script>

<template>
    <BaseModal :title="i18n.commands.properties.title" @close="leave">
        <form
            data-level-info
            :data-modal-busy="!readOnly && dirty ? '' : undefined"
            @submit.prevent="submit"
            @modalcancel="leave"
        >
            <div class="flex flex-col gap-3">
                <BaseField
                    v-if="!peekedSession"
                    :label="i18n.levelInfo.file"
                    :label-id="fileId"
                    class="level-info-media"
                >
                    <div class="flex min-w-0 flex-wrap items-center gap-2">
                        <p
                            class="min-w-0 flex-1 basis-32 select-text whitespace-pre-wrap [overflow-wrap:anywhere]"
                            data-status-summary
                        >
                            {{ fileLine }}
                        </p>
                        <button
                            type="button"
                            :class="buttonClass"
                            data-level-info-check
                            @click="check"
                        >
                            {{ i18n.levelInfo.check }}
                        </button>
                    </div>
                </BaseField>

                <fieldset class="contents" :disabled="readOnly">
                    <OptionalTextField
                        v-model="draft.title"
                        :label="i18n.historyChanges.fields.title"
                    />
                    <OptionalTextField
                        v-model="draft.artists"
                        :label="i18n.historyChanges.fields.artists"
                    />
                    <OptionalTextField
                        v-model="draft.author"
                        :label="i18n.historyChanges.fields.author"
                    />
                    <OptionalNumberField
                        v-model="draft.rating"
                        :label="i18n.historyChanges.fields.rating"
                        step="any"
                    />
                    <OptionalTextField
                        v-model="draft.tags"
                        :label="i18n.historyChanges.fields.tags"
                        :placeholder="i18n.levelInfo.tagsPlaceholder"
                    />
                    <TextAreaField
                        v-model="draft.description"
                        :label="i18n.historyChanges.fields.description"
                    />
                </fieldset>

                <MediaRow
                    :label="i18n.historyChanges.fields.cover"
                    :summary="coverLine"
                    data-level-info-cover
                >
                    <template v-if="draft.cover" #lead>
                        <div
                            class="flex size-24 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-button text-center text-sm text-fg/80 shadow-md"
                            data-level-info-cover-tile
                        >
                            <img
                                v-if="cover.status.value === 'ready'"
                                :src="cover.url.value"
                                alt=""
                                class="size-full object-contain"
                                data-level-info-thumbnail
                            />
                            <span v-else-if="cover.status.value === 'absent'" class="px-2">{{
                                i18n.levelInfo.notLoaded
                            }}</span>
                        </div>
                    </template>
                    <button
                        type="button"
                        :class="buttonClass"
                        :disabled="readOnly"
                        data-level-info-cover-choose
                        @click="choose('cover')"
                    >
                        {{ i18n.commands.previewAssets.choose }}
                    </button>
                    <button
                        type="button"
                        :class="buttonClass"
                        :disabled="readOnly || cover.status.value !== 'ready'"
                        data-level-info-cover-edit
                        @click="editCover"
                    >
                        {{ i18n.levelInfo.editCover }}
                    </button>
                    <button
                        type="button"
                        :class="buttonClass"
                        :disabled="readOnly || !draft.cover"
                        data-level-info-cover-remove
                        @click="draft.cover = undefined"
                    >
                        {{ i18n.commands.previewAssets.remove }}
                    </button>
                </MediaRow>

                <MediaRow
                    :label="i18n.historyChanges.fields.previewAudio"
                    :summary="previewLine"
                    data-level-info-preview
                >
                    <template #lead>
                        <button
                            v-if="preview.status.value === 'ready'"
                            type="button"
                            class="btn btn-secondary flex size-9 shrink-0 items-center justify-center rounded-full"
                            :aria-label="
                                playing ? i18n.commands.stop.title : i18n.commands.play.title
                            "
                            :title="playing ? i18n.commands.stop.title : i18n.commands.play.title"
                            data-level-info-preview-play
                            @click="togglePlay"
                        >
                            <StopIcon v-if="playing" class="size-4 fill-current" />
                            <PlayIcon v-else :state="false" class="size-4 fill-current" />
                        </button>
                    </template>
                    <button
                        type="button"
                        :class="buttonClass"
                        :disabled="readOnly"
                        data-level-info-preview-make
                        @click="makePreview"
                    >
                        {{ i18n.levelInfo.makePreview }}
                    </button>
                    <button
                        type="button"
                        :class="buttonClass"
                        :disabled="readOnly"
                        data-level-info-preview-choose
                        @click="choose('preview')"
                    >
                        {{ i18n.commands.previewAssets.choose }}
                    </button>
                    <button
                        type="button"
                        :class="buttonClass"
                        :disabled="readOnly || !draft.preview"
                        data-level-info-preview-remove
                        @click="draft.preview = undefined"
                    >
                        {{ i18n.commands.previewAssets.remove }}
                    </button>
                </MediaRow>

                <fieldset class="contents" :disabled="readOnly">
                    <NumberField
                        v-model="draft.life"
                        :label="i18n.commands.properties.modal.life"
                        :min="1"
                        :step="1"
                    />
                </fieldset>
            </div>

            <div class="mt-4 flex justify-end">
                <input
                    class="btn btn-primary h-9 min-w-24 max-w-full truncate rounded-full px-4"
                    type="submit"
                    :value="readOnly ? i18n.modals.info.ok : i18n.modals.form.confirm"
                />
            </div>
        </form>
    </BaseModal>
</template>

<style>
/* Labels sit at the first line of their value, which may be several lines or a taller control. */
[data-level-info] .form-field-row {
    align-items: flex-start;
}

[data-level-info] .level-info-media .form-field-label {
    min-height: 2.25rem;
}

/* One label column for every row, so the values take the rest. */
@media (min-width: 640px) {
    [data-level-info] .form-field:not(.form-field-value-stacked) .form-field-label {
        width: 9rem;
    }
}

/* On a phone every label sits above its value, as Settings stacks long values. */
@media (max-width: 639.98px) {
    [data-level-info] .form-field-row {
        display: flex;
        flex-direction: column;
        align-items: stretch;
        gap: 0.25rem;
    }

    [data-level-info] .form-field .form-field-label {
        width: auto;
        min-height: 2rem;
    }

    /* The narrow-dock rule pads a value; here it is as wide as its label. */
    [data-level-info] .form-field-row > div {
        padding-inline: 0;
    }
}
</style>
