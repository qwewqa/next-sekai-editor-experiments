<script setup lang="ts">
import { computed, onBeforeUnmount, provide, ref, shallowReactive, useId, watch } from 'vue'
import { vScrollEdges } from '../../../directives/scrollEdges'
import { state } from '../../../history'
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
import { bgmStatus } from '../../media/heldBgm'
import { pickFile } from '../../../utils/file'
import { runCommand } from '../runCommand'
import { statusText } from '../../labelText'
import { peekedSession } from '../../history/selection'
import { changedFields, type Draft } from '../../levelInfo/draft'
import MediaRow from '../../levelInfo/MediaRow.vue'
import {
    attachPicked,
    capturePicked,
    holdPicked,
    type MediaSlot,
    type Picked,
    type Source,
} from '../../levelInfo/picked'
import {
    editCover as openCoverEditor,
    makePreview as openPreviewEditor,
} from '../../levelInfo/utilities'
import { useMedia } from '../../levelInfo/useMedia'
import { chooseAudio } from '../bgm/chooseAudio'
import { changeBgm } from '../bgm'
import { checkProject } from '../checkProject'
import PlayIcon from '../play/PlayIcon.vue'
import StopIcon from '../stop/StopIcon.vue'

// Level Info (Part 1 §1.4.12, Step 11 design §3.1): one form for the level's identity text,
// Cover, Preview Audio and Initial Life. It keeps a draft, and Apply hands it to the command,
// which makes one step of the fields that changed. The BGM row acts at once, as the BGM dialog
// does. Cover Editor and Preview Editor open over it and return their result to the draft.

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
    // A plain copy: the form's own object is reactive.
    // eslint-disable-next-line @typescript-eslint/no-misused-spread
    else emit('close', { ...draft })
}

// --- The file line and Check.
const fileLine = statusText
const fileId = useId()
const check = () => {
    void runCommand(checkProject)
}

// --- Cover.
const cover = useMedia(() => draft.cover)
const coverCaption = computed(() => {
    const ref = draft.cover
    if (!ref) return ''
    const name = ref.filename || i18n.value.historyChanges.fields.cover
    return cover.status.value === 'absent' ? `${name} · ${i18n.value.levelInfo.notLoaded}` : name
})

// --- Preview Audio.
const preview = useMedia(() => draft.preview)
const previewLine = computed(() => {
    const ref = draft.preview
    if (!ref) return i18n.value.modals.form.notSet
    const name = ref.filename || i18n.value.historyChanges.fields.previewAudio
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
        void media.reload()
        return
    }
    holdPicked(picked)
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

// --- BGM. Its row shows the displayed state's BGM; Change… acts at once, as a step of its own.
const bgm = computed(() => state.value.bgm)
const unheld = ref(false)
watch(
    () => [bgm.value.meta?.hash, !!bgm.value.buffer] as const,
    async ([hash]) => {
        unheld.value = false
        const { meta, buffer } = bgm.value
        if (!meta || buffer) return
        const status = await bgmStatus(meta.hash, meta.size)
        if (bgm.value.meta?.hash === hash && !bgm.value.buffer) unheld.value = status === 'absent'
    },
    { immediate: true },
)
const bgmLine = computed(() => {
    const { meta, buffer, filename } = bgm.value
    if (!meta) return i18n.value.save.noBgm
    const parts = [
        [meta.filename, filename].find((each) => !!each) ?? i18n.value.commands.bgm.title,
    ]
    const seconds = buffer
        ? buffer.duration
        : meta.durationMs === undefined
          ? undefined
          : meta.durationMs / 1000
    if (seconds !== undefined) {
        const whole = Math.round(seconds)
        parts.push(`${Math.floor(whole / 60)}:${`${whole % 60}`.padStart(2, '0')}`)
    }
    if (unheld.value) parts.push(i18n.value.levelInfo.notLoaded)
    return parts.join(' · ')
})
const changeBgmFromHere = () => {
    if (unheld.value) void chooseAudio()
    else void changeBgm()
}

const buttonClass = 'btn btn-secondary h-9 min-w-24 max-w-full truncate rounded-full px-4'
// The cover's buttons share a column, so a long label wraps rather than truncates.
const stackedButtonClass =
    'btn btn-secondary min-h-9 w-full max-w-full whitespace-normal rounded-[1.125rem] px-3 py-1 text-center leading-tight'
</script>

<template>
    <BaseModal :title="i18n.commands.properties.title" fill @close="leave">
        <form
            class="flex min-h-0 flex-1 flex-col"
            data-level-info
            :data-modal-busy="!readOnly && dirty ? '' : undefined"
            @submit.prevent="submit"
            @modalcancel="leave"
        >
            <div
                v-scroll-edges
                class="relative flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4"
            >
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
                    <div
                        class="flex flex-col gap-3 sm:grid sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-x-4"
                    >
                        <div
                            role="group"
                            :aria-label="i18n.historyChanges.fields.cover"
                            class="flex gap-3 sm:flex-col sm:gap-2"
                            data-level-info-cover
                        >
                            <div class="flex w-24 shrink-0 flex-col gap-1.5 sm:w-36">
                                <span class="flex min-h-8 items-center">{{
                                    i18n.historyChanges.fields.cover
                                }}</span>
                                <div
                                    class="flex size-24 items-center justify-center overflow-hidden rounded-xl bg-button shadow-md sm:size-36"
                                >
                                    <img
                                        v-if="draft.cover && cover.status.value === 'ready'"
                                        :src="cover.url.value"
                                        alt=""
                                        class="size-full object-contain"
                                        data-level-info-thumbnail
                                    />
                                    <span
                                        v-else-if="!draft.cover"
                                        class="px-2 text-center text-sm text-fg/80"
                                        >{{ i18n.modals.form.notSet }}</span
                                    >
                                </div>
                                <p
                                    v-if="draft.cover"
                                    class="select-text break-words text-sm text-fg/80 [overflow-wrap:anywhere]"
                                    data-level-info-cover-name
                                >
                                    {{ coverCaption }}
                                </p>
                            </div>
                            <div
                                class="flex min-w-0 flex-1 flex-col gap-2 pt-10 sm:flex-none sm:pt-0"
                            >
                                <button
                                    type="button"
                                    :class="stackedButtonClass"
                                    data-level-info-cover-choose
                                    @click="choose('cover')"
                                >
                                    {{ i18n.commands.previewAssets.choose }}
                                </button>
                                <button
                                    type="button"
                                    :class="stackedButtonClass"
                                    :disabled="cover.status.value !== 'ready'"
                                    data-level-info-cover-edit
                                    @click="editCover"
                                >
                                    {{ i18n.levelInfo.editCover }}
                                </button>
                                <button
                                    type="button"
                                    :class="stackedButtonClass"
                                    :disabled="!draft.cover"
                                    data-level-info-cover-remove
                                    @click="draft.cover = undefined"
                                >
                                    {{ i18n.commands.previewAssets.remove }}
                                </button>
                            </div>
                        </div>

                        <div class="level-info-aside flex min-w-0 flex-col gap-3">
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
                                class="level-info-area"
                                :label="i18n.historyChanges.fields.description"
                            />
                        </div>
                    </div>
                </fieldset>

                <MediaRow :label="i18n.levelInfo.bgm" :summary="bgmLine" data-level-info-bgm>
                    <button
                        type="button"
                        :class="buttonClass"
                        :disabled="readOnly"
                        :aria-label="unheld ? undefined : i18n.levelInfo.changeBgmLabel"
                        data-level-info-bgm-change
                        @click="changeBgmFromHere"
                    >
                        {{ unheld ? i18n.notice.chooseAudio : i18n.levelInfo.change }}
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

            <div class="flex shrink-0 justify-end gap-2 border-t border-fg/15 p-4">
                <template v-if="readOnly">
                    <button
                        type="submit"
                        class="btn btn-primary h-9 min-w-24 max-w-full truncate rounded-full px-4"
                    >
                        {{ i18n.modals.close }}
                    </button>
                </template>
                <template v-else>
                    <button type="button" :class="buttonClass" @click="leave">
                        {{ i18n.modals.confirm.cancel }}
                    </button>
                    <button
                        type="submit"
                        class="btn btn-primary h-9 min-w-24 max-w-full truncate rounded-full px-4"
                    >
                        {{ i18n.levelInfo.apply }}
                    </button>
                </template>
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

/* A row of buttons beside its label has little room on a phone: the value goes below the label. */
@container (max-width: 26rem) {
    [data-level-info] .level-info-media .form-field-row {
        display: flex;
        flex-direction: column;
        align-items: stretch;
        gap: 0;
    }

    [data-level-info] .level-info-media .form-field-label {
        width: auto;
        min-height: 2rem;
    }

    /* The narrow-dock rule pads the value; here it is as wide as the label. */
    [data-level-info] .level-info-media .form-field-row > div {
        padding-inline: 0;
    }
}

/* From sm the cover sits beside the text fields, so every row keeps its values in one column:
   the labels of the rows beside the cover are as much shorter as the cover column is wide
   (9rem and its 1rem gap). Rows that stack a long value keep the field's own layout. */
@media (min-width: 640px) {
    [data-level-info] .form-field:not(.form-field-value-stacked) .form-field-label {
        width: 18rem;
    }

    [data-level-info]
        .level-info-aside
        .form-field:not(.form-field-value-stacked)
        .form-field-label {
        width: 8rem;
    }
}
</style>
