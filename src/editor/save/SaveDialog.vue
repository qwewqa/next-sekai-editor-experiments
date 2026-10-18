<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useId, useTemplateRef } from 'vue'
import type { SaveSizeEstimate } from '../../local/save/estimate'
import { i18n } from '../../i18n'
import BaseModal from '../../modals/BaseModal.vue'
import { interpolate } from '../../utils/interpolate'
import { formatCount, formatSize } from '../../utils/size'
import { nameProblem, showsAtOnce } from '../commands/exportLevel/fileName'
import type { SaveDialogInput, SaveDialogResult } from './dialogs'

// The Save dialog (Part 1 §1.4.7): the first Save, Save As… and Save to File…. File Name with
// its round 8 and 9 rules, History and BGM with their sizes and disabled states, the total, and
// the notes that apply. It names the file only: the session's Name is Level Info's.
const props = defineProps<{ input: SaveDialogInput }>()

const emit = defineEmits<{ close: [result: SaveDialogResult] }>()

const ids = useId()
const field = useTemplateRef<HTMLInputElement>('field')

// --- File Name. A typed ".nxsp" is not doubled; an empty field means its placeholder.
const value = ref(props.input.name)
const placeholder = computed(() => i18n.value.save.placeholder)
const stem = computed(() => (value.value || placeholder.value).replace(/\.nxsp$/i, ''))
const problem = computed(() => nameProblem(value.value.replace(/\.nxsp$/i, '')))

// A forbidden character or a reserved name shows at once; the edge and length reasons after a
// short pause, on blur or on submit, so typing "Coconut (Master)" never flashes one at a space.
const revealed = ref(false)
let pause: ReturnType<typeof setTimeout> | undefined
const onInput = () => {
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

// --- The rows. A disabled row never changes its option: it answers as it was given.
const history = ref(props.input.history.kind === 'available' && props.input.history.ticked)
const bgm = ref(props.input.bgm.kind === 'held' && props.input.bgm.ticked)
const historyRow = computed(() => props.input.history)
const bgmRow = computed(() => props.input.bgm)
const historyDisabled = computed(
    () => historyRow.value.kind !== 'available' || historyRow.value.locked,
)
const bgmDisabled = computed(() => bgmRow.value.kind !== 'held' || bgmRow.value.locked)

// --- The size preview: never blocking; a cached estimate shows at once and is refreshed.
const estimate = ref<SaveSizeEstimate | undefined>(props.input.estimate.cached)
const failed = ref(false)
let closed = false
onMounted(async () => {
    const loaded = await props.input.estimate.load().catch(() => undefined)
    if (closed) return
    if (loaded) estimate.value = loaded
    else if (!estimate.value) failed.value = true
})

const historyDetail = computed(() => {
    const row = historyRow.value
    if (row.kind === 'insecure') return ''
    const steps = formatCount(row.steps)
    return estimate.value
        ? interpolate(
              () => i18n.value.save.historySize,
              steps,
              formatSize(estimate.value.history),
          )()
        : interpolate(() => i18n.value.save.historySteps, steps)()
})
const bgmDetail = computed(() => {
    const row = bgmRow.value
    if (row.kind === 'none') return i18n.value.save.noBgm
    if (row.kind === 'notLoaded') return i18n.value.save.bgmNotLoaded
    return estimate.value?.bgm === undefined
        ? row.name
        : interpolate(() => i18n.value.save.bgmSize, row.name, formatSize(estimate.value.bgm))()
})

// The total follows the ticks at once, with no new estimate.
const total = computed(() => {
    const sizes = estimate.value
    if (!sizes) return
    return sizes.base + (history.value ? sizes.history : 0) + (bgm.value ? (sizes.bgm ?? 0) : 0)
})
const totalText = computed(() =>
    total.value === undefined
        ? i18n.value.save.sizePending
        : interpolate(() => i18n.value.save.sizeTotal, formatSize(total.value))(),
)

const keptText = (name: string) => interpolate(() => i18n.value.save.keptOptions, name)()

// --- The Export line: "Export Level Data…" in it is the link.
const hint = computed(() => i18n.value.save.exportHint)
const link = computed(() => i18n.value.commands.exportLevel.title)
const hintParts = computed(() => {
    const at = hint.value.indexOf(link.value)
    return at < 0
        ? undefined
        : [hint.value.slice(0, at), link.value, hint.value.slice(at + link.value.length)]
})

const title = computed(() =>
    props.input.kind === 'saveAs' ? i18n.value.save.titleAs : i18n.value.save.title,
)

const submit = () => {
    if (problem.value) {
        reveal()
        field.value?.focus()
        return
    }
    emit('close', {
        action: 'save',
        fileName: `${stem.value}.nxsp`.normalize('NFC'),
        history: history.value,
        bgm: bgm.value,
    })
}

const cancel = () => {
    emit('close', undefined)
}

onBeforeUnmount(() => {
    closed = true
    clearTimeout(pause)
})

const buttonClass =
    'h-9 min-w-24 max-w-full truncate rounded-full px-4 shadow-md outline-none -outline-offset-2 transition-colors hover:shadow-accent focus-visible:ring-2 focus-visible:ring-fg disabled:pointer-events-none disabled:opacity-40 [@media(pointer:coarse)]:h-11'
const rowClass =
    'relative flex min-h-10 items-start gap-3 rounded-xl px-3 py-2 transition-colors has-[:active]:bg-accent has-[:active]:text-on-accent has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-fg [@media(hover:hover)]:hover:bg-band-hover [@media(pointer:coarse)]:min-h-12'
const boxClass =
    'pointer-events-none relative mt-0.5 size-4 shrink-0 rounded border-2 border-fg after:absolute after:inset-0.5 after:scale-0 after:rounded-[1px] after:bg-fg after:transition-transform peer-checked:after:scale-100 peer-disabled:opacity-50'
</script>

<template>
    <BaseModal :title="title" @close="cancel">
        <form
            novalidate
            class="flex flex-col gap-4"
            data-save-dialog
            @submit.prevent="submit"
            @modalcancel="cancel"
        >
            <p v-for="(line, i) in input.lines" :key="i" data-save-line>{{ line() }}</p>

            <div class="flex flex-col gap-1">
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
                            data-save-name
                            @input="onInput"
                            @blur="reveal"
                            @keydown.enter="reveal"
                        />
                        <span class="shrink-0" aria-hidden="true">.nxsp</span>
                    </span>
                </label>
                <p
                    v-if="shownProblem"
                    :id="`${ids}-problem`"
                    role="alert"
                    class="text-sm text-danger"
                    data-save-problem
                >
                    {{ problemText }}
                </p>
            </div>

            <fieldset class="flex flex-col" data-save-include>
                <legend class="mb-1 px-3 opacity-75">{{ i18n.save.include }}</legend>
                <label :class="rowClass" data-save-row="history">
                    <input
                        v-model="history"
                        type="checkbox"
                        class="peer absolute inset-0 size-full cursor-pointer opacity-0 focus-visible:outline-none disabled:cursor-default"
                        :disabled="historyDisabled"
                        :aria-labelledby="`${ids}-history-label`"
                        :aria-describedby="`${ids}-history`"
                    />
                    <span :class="boxClass" aria-hidden="true" />
                    <span class="pointer-events-none flex min-w-0 flex-1 flex-col">
                        <span class="flex flex-wrap justify-between gap-x-3">
                            <span :id="`${ids}-history-label`">{{ i18n.save.history }}</span>
                            <span v-if="historyDetail" class="opacity-75" data-save-size>{{
                                historyDetail
                            }}</span>
                        </span>
                        <span :id="`${ids}-history`" class="flex flex-col text-sm opacity-75">
                            <span v-if="historyRow.kind === 'insecure'">{{
                                i18n.save.noHistoryHere
                            }}</span>
                            <template v-else>
                                <span>{{ i18n.save.historyNote }}</span>
                                <span v-if="historyRow.keptIn" data-save-kept>{{
                                    keptText(historyRow.keptIn)
                                }}</span>
                            </template>
                        </span>
                    </span>
                </label>
                <label :class="rowClass" data-save-row="bgm">
                    <input
                        v-model="bgm"
                        type="checkbox"
                        class="peer absolute inset-0 size-full cursor-pointer opacity-0 focus-visible:outline-none disabled:cursor-default"
                        :disabled="bgmDisabled"
                        :aria-labelledby="`${ids}-bgm-label`"
                        :aria-describedby="`${ids}-bgm`"
                    />
                    <span :class="boxClass" aria-hidden="true" />
                    <span class="pointer-events-none flex min-w-0 flex-1 flex-col">
                        <span class="flex flex-wrap justify-between gap-x-3">
                            <span :id="`${ids}-bgm-label`">{{ i18n.save.bgm }}</span>
                        </span>
                        <span :id="`${ids}-bgm`" class="flex flex-col text-sm opacity-75">
                            <span class="break-all" data-save-size>{{ bgmDetail }}</span>
                            <span v-if="bgmRow.kind === 'held' && bgmRow.keptIn" data-save-kept>{{
                                keptText(bgmRow.keptIn)
                            }}</span>
                        </span>
                    </span>
                </label>
            </fieldset>

            <p v-if="!failed" class="px-3 font-medium" aria-live="polite" data-save-total>
                {{ totalText }}
            </p>

            <div class="flex flex-col gap-1 text-sm">
                <p v-if="input.exportLine" data-save-export>
                    <template v-if="hintParts"
                        >{{ hintParts[0]
                        }}<button
                            type="button"
                            class="underline outline-none focus-visible:ring-2 focus-visible:ring-fg"
                            @click="emit('close', { action: 'export' })"
                        >
                            {{ hintParts[1] }}</button
                        >{{ hintParts[2] }}</template
                    >
                    <button
                        v-else
                        type="button"
                        class="text-left underline outline-none focus-visible:ring-2 focus-visible:ring-fg"
                        @click="emit('close', { action: 'export' })"
                    >
                        {{ hint }}
                    </button>
                </p>
                <p v-if="input.downloadNote" class="opacity-75" data-save-download-note>
                    {{ i18n.save.downloadNote }}
                </p>
                <p v-if="input.storageLine" class="opacity-75" data-save-storage-line>
                    {{ input.storageLine() }}
                </p>
                <p v-if="input.peeking" class="opacity-75" data-save-peeking>
                    {{ i18n.peek.savesCurrent }}
                </p>
            </div>

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
                    type="submit"
                    class="bg-accent text-on-accent active:bg-button active:text-fg"
                    :class="buttonClass"
                    :disabled="!!problem"
                >
                    {{ i18n.commands.save.title }}
                </button>
            </div>
        </form>
    </BaseModal>
</template>
