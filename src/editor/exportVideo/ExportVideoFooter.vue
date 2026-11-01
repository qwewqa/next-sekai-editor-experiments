<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useId, useTemplateRef, watch } from 'vue'
import { vFocusRescue } from '../../directives/focusRescue'
import { i18n } from '../../i18n'
import { inlineName } from '../../utils/inlineName'
import { interpolateRaw } from '../../utils/interpolate'
import { formatSize } from '../../utils/size'
import WaitBar from '../workspace/WaitBar.vue'
import { formatClipTime } from './clipTime'
import type { ExportDialog } from './dialog'

// The pinned footer: the summary or the export's status, then the buttons for the state.
const props = defineProps<{
    dialog: ExportDialog
    /** A save picker names the file, so Export asks first. */
    picker: boolean
}>()
const emit = defineEmits<{
    export: []
    cancel: []
    close: []
    deliver: [how: 'download' | 'share']
}>()

const d = props.dialog
const ids = useId()
const strings = computed(() => i18n.value.exportVideo)
const phase = d.phase
const exportLabel = computed(() => (props.picker ? strings.value.export : strings.value.exportNow))

// --- The summary: each item whole, its separator leading it, so a line breaks between items.
const about = (text: string) => interpolateRaw(strings.value.about, text)
const formatName = computed(() => (d.format.value === 'webm' ? 'WebM' : 'MP4'))
const tail = computed(() => [
    formatName.value,
    formatClipTime(d.length.value, d.hours),
    about(formatSize(d.bytes.value)),
])
const longSummary = computed(() => [
    `${d.size.value.width} × ${d.size.value.height}`,
    interpolateRaw(strings.value.fps, `${d.form.frameRate}`),
    ...tail.value,
])
const shortSummary = computed(() => [`${d.form.resolution}p`, ...tail.value])
const status = useTemplateRef<HTMLDivElement>('status')
const measure = useTemplateRef<HTMLSpanElement>('measure')
const useShort = ref(false)
const fit = () => {
    const room = status.value?.clientWidth ?? 0
    const needed = measure.value?.scrollWidth ?? 0
    useShort.value = room > 0 && needed > room
}
let observer: ResizeObserver | undefined
onMounted(() => {
    observer = new ResizeObserver(fit)
    if (status.value) observer.observe(status.value)
    fit()
})
onBeforeUnmount(() => observer?.disconnect())
watch(longSummary, () => requestAnimationFrame(fit))
const summary = computed(() => (useShort.value ? shortSummary.value : longSummary.value))

// --- The export's progress: the time left from 5 s into the render, once a second at most.
const left = ref<string>()
let exportingSince: number | undefined
let lastChange = 0
watch(
    () => [phase.value, d.progress.value] as const,
    ([value, progress]) => {
        if (value !== 'exporting') {
            exportingSince = undefined
            left.value = undefined
            return
        }
        const now = performance.now()
        exportingSince ??= now
        if (progress.eta === undefined || now - exportingSince < 5000) return
        if (now - lastChange < 1000) return
        const text =
            progress.eta < 60
                ? strings.value.lessThanMinuteLeft
                : interpolateRaw(strings.value.minutesLeft, `${Math.round(progress.eta / 60)}`)
        if (text !== left.value) {
            left.value = text
            lastChange = now
        }
    },
)
const stage = computed(() => {
    switch (phase.value) {
        case 'preparing':
            return strings.value.preparing
        case 'exporting':
            return strings.value.exporting
        case 'cancelling':
            return strings.value.cancelling
        case 'finishing':
            return strings.value.finishing
        case 'setup':
        case 'ready':
        case 'done':
        case 'failed':
            return undefined
    }
})
const barValue = computed(() =>
    phase.value === 'exporting'
        ? Math.round(d.progress.value.fraction * 1000) / 10
        : phase.value === 'finishing'
          ? 100
          : undefined,
)
const doneText = computed(() => {
    const outcome = d.outcome.value
    if (outcome?.kind !== 'done') return undefined
    return {
        name: interpolateRaw(strings.value.exported, inlineName(outcome.name)),
        sizeText: outcome.size === undefined ? undefined : formatSize(outcome.size),
    }
})
const ready = computed(() => (d.outcome.value?.kind === 'ready' ? d.outcome.value : undefined))

// Buttons: the secondary reads Cancel, then Close once an export failed; it keeps focus across.
const cancelOff = computed(() => phase.value === 'cancelling' || phase.value === 'finishing')
const secondary = useTemplateRef<HTMLButtonElement>('secondary')
const primary = useTemplateRef<HTMLButtonElement>('primary')
const download = useTemplateRef<HTMLButtonElement>('download')
const onSecondary = () => {
    if (cancelOff.value) return
    if (d.busy.value) emit('cancel')
    else emit('close')
}
defineExpose({
    focusFor: (value: typeof phase.value) => {
        if (value === 'preparing') secondary.value?.focus()
        else if (value === 'done') primary.value?.focus()
        else if (value === 'ready') download.value?.focus()
        else if (value === 'failed') secondary.value?.focus()
    },
})

const button = 'export-hit btn relative h-9 min-w-24 max-w-full rounded-full px-4'
</script>

<template>
    <footer
        v-focus-rescue
        class="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-fg/15 p-4"
        data-export-footer
    >
        <div
            ref="status"
            class="relative mr-auto min-w-0 flex-[1_1_16rem] overflow-hidden"
            data-export-status
        >
            <span
                ref="measure"
                class="pointer-events-none invisible absolute whitespace-nowrap text-sm tabular-nums"
                aria-hidden="true"
                >{{ longSummary.join(' · ') }}</span
            >
            <!-- Mounted throughout, so each stage and the outcome are read. -->
            <div role="status">
                <div v-if="stage" class="flex flex-col gap-1.5">
                    <p :id="`${ids}-stage`" class="truncate text-sm">
                        {{ stage }}<span v-if="left" class="text-fg/80"> · {{ left }}</span>
                    </p>
                    <WaitBar :value="barValue" :labelledby="`${ids}-stage`" />
                </div>
                <p v-else-if="doneText" class="text-sm" data-export-done>
                    <span class="[overflow-wrap:anywhere]">{{ doneText.name }}</span
                    ><span v-if="doneText.sizeText" class="whitespace-nowrap">
                        · {{ doneText.sizeText }}</span
                    >
                </p>
                <p v-else-if="ready" class="text-sm" data-export-ready>
                    {{ strings.ready }} · {{ formatSize(ready.size) }}
                </p>
            </div>
            <p
                v-if="!stage && !doneText && !ready"
                class="text-sm tabular-nums"
                data-export-summary
            >
                <template v-for="(item, index) in summary" :key="index"
                    >{{ index ? ' ' : ''
                    }}<span class="whitespace-nowrap"
                        >{{ index ? '· ' : '' }}{{ item }}</span
                    ></template
                >
            </p>
        </div>
        <template v-if="ready">
            <div class="flex gap-2">
                <button
                    ref="secondary"
                    type="button"
                    :class="[button, 'btn-secondary']"
                    data-export-close
                    @click="emit('close')"
                >
                    <span class="truncate">{{ i18n.modals.close }}</span>
                </button>
                <button
                    type="button"
                    :class="[button, 'btn-secondary']"
                    :disabled="!d.ready.value"
                    data-export-start
                    @click="emit('export')"
                >
                    <span class="truncate">{{ exportLabel }}</span>
                </button>
            </div>
            <div class="flex gap-2">
                <button
                    v-if="ready.shareable"
                    type="button"
                    :class="[button, 'btn-secondary']"
                    data-export-share
                    @click="emit('deliver', 'share')"
                >
                    <span class="truncate">{{ strings.share }}</span>
                </button>
                <button
                    ref="download"
                    type="button"
                    :class="[button, 'btn-primary']"
                    data-export-download
                    @click="emit('deliver', 'download')"
                >
                    <span class="truncate">{{ strings.download }}</span>
                </button>
            </div>
        </template>
        <template v-else-if="phase === 'done'">
            <button
                type="button"
                :class="[button, 'btn-secondary']"
                :disabled="!d.ready.value"
                data-export-start
                @click="emit('export')"
            >
                <span class="truncate">{{ exportLabel }}</span>
            </button>
            <button
                ref="primary"
                type="button"
                :class="[button, 'btn-primary']"
                data-export-close
                @click="emit('close')"
            >
                <span class="truncate">{{ i18n.modals.close }}</span>
            </button>
        </template>
        <template v-else>
            <button
                ref="secondary"
                type="button"
                :class="[button, 'btn-secondary', { 'opacity-40': cancelOff }]"
                :aria-disabled="cancelOff || undefined"
                :data-export-cancel="phase === 'failed' ? undefined : ''"
                :data-export-close="phase === 'failed' ? '' : undefined"
                @click="onSecondary"
            >
                <span class="truncate">{{
                    phase === 'failed' ? i18n.modals.close : i18n.modals.confirm.cancel
                }}</span>
            </button>
            <button
                type="button"
                :class="[button, 'btn-primary']"
                :disabled="d.busy.value || !d.ready.value"
                data-export-start
                @click="emit('export')"
            >
                <span class="truncate">{{ exportLabel }}</span>
            </button>
        </template>
    </footer>
</template>

<style scoped>
/* 44 px targets. The label truncates inside, so the button keeps its ::before. */
.export-hit::before {
    content: '';
    position: absolute;
    inset: -0.25rem;
}
</style>
