<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, useTemplateRef, watch } from 'vue'
import { i18n } from '../../../i18n'
import BaseModal from '../../../modals/BaseModal.vue'
import type { ReadyPrompt } from '../../../platform'
import { interpolate } from '../../../utils/interpolate'
import { buildLevelData } from './build'
import { nameProblem, showsAtOnce } from './fileName'
import { exportByPicker, exportToTarget, type ExportContext, type ExportOutcome } from './flow'
import { formatSize } from './format'
import type { ExportTarget } from './memory'
import { exportUi } from './ui'

// Export Level Data… (Part 1 §1.4.8): the File Name row, or only the To row with a target.
const props = defineProps<{
    target?: ExportTarget
    /** The field's first value. */
    name: string
    /** The field shows the source file's own name, which the picker suggests as it is. */
    sourceName: boolean
    peeking: boolean
}>()

const emit = defineEmits<{
    close: []
}>()

const ids = useId()
const field = useTemplateRef<HTMLInputElement>('field')
const downloadButton = useTemplateRef<HTMLButtonElement>('downloadButton')

const value = ref(props.name)
const edited = ref(false)
const fromSource = computed(() => props.sourceName && !edited.value)

const placeholder = computed(() => i18n.value.export.placeholder)
// A typed ".nsld" is not doubled.
const stem = computed(() => (value.value || placeholder.value).replace(/\.nsld$/i, ''))
const fileName = computed(() =>
    (fromSource.value ? value.value : `${stem.value}.nsld`).normalize('NFC'),
)

// The source's own name is a file that exists; only a typed name is checked (§0.9.9).
const problem = computed(() => (fromSource.value ? undefined : nameProblem(value.value)))
const revealed = ref(false)
let pause: ReturnType<typeof setTimeout> | undefined
const onInput = () => {
    edited.value = true
    revealed.value = false
    clearTimeout(pause)
    pause = setTimeout(() => (revealed.value = true), 500)
}
const reveal = () => {
    clearTimeout(pause)
    revealed.value = true
}
const shownProblem = computed(() =>
    problem.value && (revealed.value || showsAtOnce(problem.value)) ? problem.value : undefined,
)
const problemText = computed(() => {
    const shown = shownProblem.value
    if (!shown) return ''
    const messages = i18n.value.name
    if (shown.reason === 'invalidChar') return interpolate(() => messages.invalidChar, shown.char)()
    if (shown.reason === 'reserved') return interpolate(() => messages.reserved, shown.name)()
    return messages[shown.reason]
})

const targetLabel = computed(() =>
    props.target
        ? interpolate(
              () =>
                  props.target?.exported
                      ? i18n.value.export.targetLast
                      : i18n.value.export.targetOpened,
              props.target.name,
          )()
        : '',
)

const busy = ref(false)
const preparing = ref<{ name: string; size: number }>()
let answerReady: ((go: boolean) => void) | undefined

const ready: ReadyPrompt = (file) =>
    new Promise((resolve) => {
        answerReady = resolve
        preparing.value = file
        busy.value = false
    })
watch(preparing, async (file) => {
    if (!file) return
    await nextTick()
    downloadButton.value?.focus()
})
const preparingText = computed(() =>
    preparing.value
        ? interpolate(
              () => i18n.value.save.preparing,
              preparing.value.name,
              formatSize(preparing.value.size),
          )()
        : '',
)

// Cancel, × and Escape stop a running export; once a follow-up dialog takes over, it runs on.
// An accepted pick, which the picker emptied (D5), is written first, then the dialog closes.
const controller = new AbortController()
let left = false
let committed = false

const context = (): ExportContext => ({
    ui: exportUi,
    build: buildLevelData,
    suggestedName: fileName.value,
    // The source's own name lists "All files" alone, so a typed name keeps no added extension.
    types: fromSource.value
        ? []
        : [{ description: i18n.value.export.fileType, extension: '.nsld' }],
    exportName: fromSource.value ? undefined : value.value,
    leave: () => {
        left = true
        emit('close')
    },
    ready,
    signal: controller.signal,
    committed: () => {
        committed = true
    },
})

// The flow starts in the press itself, so its first call keeps the gesture.
const run = async (outcome: Promise<ExportOutcome>) => {
    busy.value = true
    try {
        if ((await outcome) !== 'back') emit('close')
    } finally {
        busy.value = false
    }
}

const submit = () => {
    if (busy.value || preparing.value) return
    if (props.target) {
        void run(exportToTarget(context(), props.target))
        return
    }
    if (problem.value) {
        reveal()
        field.value?.focus()
        return
    }
    void run(exportByPicker(context()))
}

const chooseAnother = () => {
    if (busy.value) return
    void run(exportByPicker(context()))
}

const download = () => {
    answerReady?.(true)
    answerReady = undefined
}

const stop = () => {
    if (!left && !committed) controller.abort()
    answerReady?.(false)
    answerReady = undefined
}

const cancel = () => {
    stop()
    if (committed && busy.value) return
    emit('close')
}

onBeforeUnmount(() => {
    clearTimeout(pause)
    stop()
})

const buttonClass =
    'h-9 min-w-24 max-w-full truncate rounded-full px-4 shadow-md outline-none -outline-offset-2 transition-colors hover:shadow-accent focus-visible:ring-2 focus-visible:ring-fg disabled:pointer-events-none disabled:opacity-40'
</script>

<template>
    <BaseModal :title="i18n.export.title" @close="cancel">
        <form
            novalidate
            class="flex flex-col gap-4"
            :data-modal-busy="busy || undefined"
            @submit.prevent="submit"
            @modalcancel="cancel"
        >
            <p v-if="preparing" :id="`${ids}-preparing`" data-export-preparing>
                {{ preparingText }}
            </p>
            <template v-else>
                <div
                    v-if="target"
                    class="flex flex-wrap items-center gap-x-3 gap-y-2"
                    data-export-target
                >
                    <span class="shrink-0 opacity-75">{{ i18n.export.to }}</span>
                    <span class="min-w-40 flex-1 break-words font-medium" data-export-target-name>{{
                        targetLabel
                    }}</span>
                    <!-- Wrapped below a long name, it keeps to the right. -->
                    <button
                        type="button"
                        class="ml-auto bg-button active:bg-accent active:text-on-accent"
                        :class="buttonClass"
                        :disabled="busy"
                        @click="chooseAnother"
                    >
                        {{ i18n.save.chooseAnother }}
                    </button>
                </div>
                <div v-else class="flex flex-col gap-1">
                    <!-- Label and field share a row while the field keeps about 12rem. -->
                    <label class="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span class="shrink-0">{{ i18n.save.fileName }}</span>
                        <span class="flex min-w-48 flex-1 items-center gap-1.5">
                            <input
                                ref="field"
                                v-model="value"
                                class="w-full min-w-0 appearance-none rounded-full bg-button px-4 py-1 shadow-md outline-none transition-colors placeholder:text-fg/50 hover:shadow-accent focus:ring-2 focus:ring-fg"
                                type="text"
                                spellcheck="false"
                                autocomplete="off"
                                :placeholder="placeholder"
                                :aria-invalid="!!shownProblem"
                                :aria-describedby="shownProblem ? `${ids}-problem` : undefined"
                                data-export-name
                                @input="onInput"
                                @blur="reveal"
                                @keydown.enter="reveal"
                            />
                            <span v-if="!fromSource" class="shrink-0" aria-hidden="true"
                                >.nsld</span
                            >
                        </span>
                    </label>
                    <p
                        v-if="shownProblem"
                        :id="`${ids}-problem`"
                        role="alert"
                        class="text-sm text-danger"
                    >
                        {{ problemText }}
                    </p>
                </div>
                <p v-if="peeking" class="text-sm opacity-75">{{ i18n.peek.exportsCurrent }}</p>
            </template>

            <div class="flex justify-end gap-2">
                <button
                    type="button"
                    class="bg-button active:bg-accent active:text-on-accent"
                    :class="buttonClass"
                    @click="cancel"
                >
                    {{ i18n.modals.confirm.cancel }}
                </button>
                <button
                    v-if="preparing"
                    ref="downloadButton"
                    type="button"
                    :aria-describedby="`${ids}-preparing`"
                    class="bg-accent text-on-accent active:bg-button active:text-fg"
                    :class="buttonClass"
                    @click="download"
                >
                    {{ i18n.save.download }}
                </button>
                <button
                    v-else
                    type="submit"
                    class="bg-accent text-on-accent active:bg-button active:text-fg"
                    :class="buttonClass"
                    :disabled="busy || !!problem"
                    :data-autofocus="target ? true : undefined"
                >
                    {{ i18n.export.export }}
                </button>
            </div>
        </form>
    </BaseModal>
</template>
