<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue'
import { vScrollEdges } from '../../directives/scrollEdges'
import { i18n } from '../../i18n'
import BaseModal from '../../modals/BaseModal.vue'
import { showChoice } from '../../modals/choice'
import { useModal } from '../../modals'
import { createFontContext } from '../../rendering/textRaster'
import { settings } from '../../settings'
import { interpolateRaw } from '../../utils/interpolate'
import { useHistoryCalendar } from '../history/calendarClock'
import { historyFormat } from '../history/historyFormat'
import { formatClipTime } from './clipTime'
import { createExportDialog, type DialogInput, type Phase } from './dialog'
import ExportVideoFooter from './ExportVideoFooter.vue'
import ExportVideoSettings from './ExportVideoSettings.vue'
import ExportVideoSlot from './ExportVideoSlot.vue'
import ExportVideoStage from './ExportVideoStage.vue'
import type { StageLayout } from './layout'

const props = defineProps<{
    input: DialogInput
    /** The History step on screen while peeking: its time, and a session's name. */
    peekStep?: { time: number; name?: string }
    /** Gives tests the dialog's state. */
    expose?: (dialog: ReturnType<typeof createExportDialog>) => void
}>()
const emit = defineEmits<{ close: [] }>()

const d = createExportDialog(props.input)

// The peek bar's own words for the step on screen.
const calendar = useHistoryCalendar()
const peekLine = computed(() => {
    const step = props.peekStep
    if (!step) return undefined
    const when = historyFormat(calendar.value, settings.locale).dateTimeSeconds(step.time)
    return interpolateRaw(
        i18n.value.history.announceViewing,
        step.name === undefined
            ? when
            : `${interpolateRaw(i18n.value.history.quoted, step.name)} · ${when}`,
    )
})
props.expose?.(d)
const modal = useModal()
const phase = d.phase

const body = useTemplateRef<HTMLDivElement>('body')
const stage = useTemplateRef<{
    play(): void
    setIn(): void
    setOut(): void
    stepBy(direction: -1 | 1, seconds?: number): void
}>('stage')
const footer = useTemplateRef<{ focusFor(phase: Phase): void }>('footer')

// --- The form: short, phone landscape, two columns or one.
type Form = StageLayout['form']
const layout = ref<StageLayout>({
    form: 'two',
    transportFit: 1,
    length: 'inline',
    stacked: false,
    compactStrip: false,
    hideRuler: false,
})
const form = computed(() => layout.value.form)

let font: CanvasRenderingContext2D | null | undefined
const textWidth = (text: string, size: number) => {
    font ??= createFontContext()
    if (!font || !body.value) return text.length * size * 0.6
    const style = getComputedStyle(body.value)
    font.font = `${size}px ${style.fontFamily}`
    return Math.ceil(font.measureText(text).width)
}

let frame = 0
const relayout = () => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(applyLayout)
}
/** A field in the dialog has focus, a chip's popover included. */
const typing = (dialog: HTMLDialogElement) => {
    const active = document.activeElement
    return (
        !!active &&
        dialog.contains(active) &&
        active.matches('input:not([type="button"], [type="checkbox"], [type="radio"]), textarea')
    )
}
/** A layout that waits for the field being typed into to lose focus. */
let held = false
const applyLayout = () => {
    const root = body.value
    const dialog = root?.closest('dialog')
    if (!root || !dialog) return
    const viewport = window.visualViewport
    const vw = viewport?.width ?? window.innerWidth
    const vh = viewport?.height ?? window.innerHeight
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
    const base: Form =
        vh < 480 && vw >= 640 ? 'land' : dialog.clientWidth >= 52 * rem ? 'two' : 'one'
    const header = root.parentElement?.previousElementSibling?.getBoundingClientRect().height ?? 48
    const footerHeight = root.querySelector<HTMLElement>('[data-export-footer]')?.offsetHeight ?? 69
    const slotHeight = root.querySelector<HTMLElement>('[data-export-slot]')?.offsetHeight ?? 0
    const room = dialog.clientHeight - header - (base === 'land' ? 0 : footerHeight) - slotHeight
    const hideRuler = base === 'land' && room < 360
    const compactStrip = vw < 640 || base === 'land'
    const side =
        base === 'two'
            ? 20 * rem
            : base === 'land'
              ? Math.min(20 * rem, 0.45 * dialog.clientWidth)
              : 0
    const strings = i18n.value.exportVideo

    // The transport: names, then icons, then Set In and Set Out only in the menu. In, Out and
    // Length: Length goes when it does not fit; then the labels go above the fields.
    const fit = (stageWidth: number, land: boolean) => {
        const readout = textWidth(formatClipTime(0, d.hours), 14)
        const leading = 3 * 36 + 2 * 8 + 12 + readout + 12
        const names =
            textWidth(strings.setIn, 16) +
            32 +
            8 +
            textWidth(strings.setOut, 16) +
            32 +
            8 +
            textWidth(strings.range, 16) +
            28 +
            20
        const transportFit: StageLayout['transportFit'] =
            leading + names <= stageWidth ? 1 : leading + 3 * 36 + 16 <= stageWidth ? 2 : 3
        const field = d.hours ? 128 : 104
        const groups =
            textWidth(strings.in, 16) + 8 + field + 12 + textWidth(strings.out, 16) + 8 + field
        const lengthWidth =
            16 +
            textWidth(strings.length, 16) +
            8 +
            textWidth(formatClipTime(d.length.value, d.hours), 16)
        const chips =
            textWidth(`${strings.in} ${formatClipTime(0, d.hours)}`, 14) +
            30 +
            8 +
            textWidth(`${strings.out} ${formatClipTime(0, d.hours)}`, 14) +
            30
        const stacked = !land && groups > stageWidth
        const rowWidth = land ? chips : stacked ? 2 * field + 12 : groups
        const length: StageLayout['length'] =
            rowWidth + lengthWidth <= stageWidth
                ? 'inline'
                : phase.value === 'ready'
                  ? 'line'
                  : 'none'
        // The stage's fixed parts: everything but the frame view.
        const gap = land ? 8 : 12
        const fixed =
            (land ? 24 : 32) +
            36 +
            (hideRuler ? 0 : 16) +
            (compactStrip ? 48 : 56) +
            (land ? 32 : stacked ? 56 : 36) +
            3 * gap +
            (peekLine.value ? 16 + gap : 0) +
            (length === 'line' ? 12 : 0)
        return { transportFit, stacked, length, fixed }
    }
    const baseFit = fit(dialog.clientWidth - side - 32, base === 'land')
    const short = room < baseFit.fixed + 120 + (base === 'one' ? 160 : 0)
    const formNow: Form = short ? 'short' : base
    // An on-screen keyboard shrinks the viewport. Into or out of land, In and Out swap between a
    // chip and a field, and the swap would remove the field being typed into.
    held = (formNow === 'land') !== (form.value === 'land') && typing(dialog)
    if (held) return
    const stageWidth = dialog.clientWidth - (short ? 0 : side) - 32
    const { transportFit, stacked, length, fixed } = short ? fit(stageWidth, false) : baseFit
    const aspect = d.size.value.width / d.size.value.height
    const frameHeight =
        formNow === 'one'
            ? Math.floor(Math.min(stageWidth / aspect, 0.45 * dialog.clientHeight))
            : formNow === 'short'
              ? Math.floor(Math.max(120, Math.min(stageWidth / aspect, room - fixed)))
              : undefined

    layout.value = {
        form: formNow,
        transportFit,
        length,
        stacked,
        frameHeight,
        compactStrip,
        hideRuler,
    }
}
watch([() => d.size.value, () => d.length.value, phase, () => i18n.value], relayout)

let observer: ResizeObserver | undefined
const onFocusChange = () => {
    if (held) relayout()
}
let dialogElement: HTMLDialogElement | null | undefined
onMounted(() => {
    dialogElement = body.value?.closest('dialog')
    observer = new ResizeObserver(relayout)
    if (dialogElement) observer.observe(dialogElement)
    window.visualViewport?.addEventListener('resize', relayout)
    // The chip popovers are teleported to the dialog, outside this component.
    dialogElement?.addEventListener('focusin', onFocusChange)
    dialogElement?.addEventListener('focusout', onFocusChange)
    applyLayout()
    // Once more after the fonts and the first layout settle.
    relayout()
    void document.fonts.ready.then(relayout)
})
onBeforeUnmount(() => {
    cancelAnimationFrame(frame)
    observer?.disconnect()
    window.visualViewport?.removeEventListener('resize', relayout)
    dialogElement?.removeEventListener('focusin', onFocusChange)
    dialogElement?.removeEventListener('focusout', onFocusChange)
    void d.dispose()
})

// --- Escape, ×, Cancel and Close per state.
// Escape and × cancel a running export first; Finishing and Ready keep the dialog (persistent).
const busyForEscape = computed(() => ['preparing', 'exporting', 'cancelling'].includes(phase.value))
watch(
    () => phase.value === 'finishing' || phase.value === 'ready',
    (value) => {
        if (modal) modal.persistent = value
    },
    { immediate: true },
)
const onModalCancel = () => {
    if (phase.value === 'preparing' || phase.value === 'exporting') d.cancel()
}
/** A file never downloaded or shared is discarded only after asking. */
const confirmDiscard = async () => {
    const ready = d.outcome.value
    if (ready?.kind !== 'ready' || ready.delivered) return true
    const choice = await showChoice({
        title: () => i18n.value.exportVideo.discardTitle,
        choices: [
            {
                value: 'discard' as const,
                label: () => i18n.value.exportVideo.discard,
                danger: true,
            },
        ],
        cancelIsDefault: true,
    })
    return choice === 'discard'
}
const close = async () => {
    if (phase.value === 'finishing' || phase.value === 'cancelling') return
    if (d.busy.value) {
        d.cancel()
        return
    }
    if (phase.value === 'ready') {
        if (!(await confirmDiscard())) return
        await d.endReady()
    }
    emit('close')
}
const startExport = async () => {
    if (phase.value === 'ready') {
        if (!(await confirmDiscard())) return
        await d.endReady()
    }
    d.start()
}
const deliver = async (how: 'download' | 'share') => {
    try {
        await d.deliver(how)
    } catch (error) {
        console.error(error)
        deliverFailed.value = how
    }
}
const deliverFailed = ref<'download' | 'share'>()
watch(phase, (value, previous) => {
    deliverFailed.value = undefined
    void nextTick(() => {
        if (value === 'preparing' || (value !== previous && value !== 'setup'))
            footer.value?.focusFor(value)
    })
})

// --- Dialog keys: I and O, the arrows and Space, outside text fields, selects and settings.
const onKeydown = (event: KeyboardEvent) => {
    if (d.busy.value || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey)
        return
    const target = event.target as HTMLElement
    if (
        target.matches('input:not([type="button"]), textarea, select') ||
        target.closest('[data-export-settings]')
    )
        return
    const key = event.key
    if (key === 'i' || key === 'I') stage.value?.setIn()
    else if (key === 'o' || key === 'O') stage.value?.setOut()
    else if (key === 'ArrowLeft' || key === 'ArrowRight')
        stage.value?.stepBy(key === 'ArrowLeft' ? -1 : 1, event.shiftKey ? 1 : undefined)
    else if (key === ' ') {
        if (target.matches('button, summary, [role="switch"], input')) return
        stage.value?.play()
    } else return
    event.preventDefault()
}

// The field being edited stays in view when the keyboard shortens the short form.
const onFocusIn = (event: FocusEvent) => {
    if (form.value !== 'short' || !(event.target instanceof HTMLInputElement)) return
    const target = event.target
    setTimeout(() => {
        target.scrollIntoView({ block: 'nearest' })
    }, 300)
}

const title = computed(() => i18n.value.exportVideo.title)
</script>

<template>
    <BaseModal :title fill :close-disabled="phase === 'finishing'" @close="close">
        <div
            ref="body"
            class="export-video flex min-h-0 flex-1 flex-col"
            :class="`form-${form}`"
            :data-modal-busy="busyForEscape || undefined"
            :data-export-form="form"
            :data-export-phase="phase"
            @modalcancel="onModalCancel"
            @keydown="onKeydown"
            @focusin="onFocusIn"
        >
            <div
                v-scroll-edges
                class="export-grid"
                :data-export-scroller="form === 'short' ? '' : undefined"
            >
                <ExportVideoStage ref="stage" :dialog="d" :layout :peek-line="peekLine" />
                <div
                    class="export-side"
                    :class="{ 'export-side-edge': form === 'two' || form === 'land' }"
                >
                    <section
                        v-scroll-edges
                        class="export-settings"
                        :class="{ 'border-t border-fg/15': form === 'one' || form === 'short' }"
                        :data-export-scroller="form === 'short' ? undefined : ''"
                    >
                        <ExportVideoSettings :dialog="d" />
                    </section>
                    <ExportVideoSlot v-if="form !== 'short'" :dialog="d" />
                    <ExportVideoFooter
                        v-if="form === 'land'"
                        ref="footer"
                        :dialog="d"
                        :picker="input.env.picker"
                        @export="startExport"
                        @cancel="d.cancel"
                        @close="close"
                        @deliver="deliver"
                    />
                </div>
            </div>
            <ExportVideoSlot v-if="form === 'short'" :dialog="d" />
            <p
                v-if="deliverFailed"
                role="alert"
                class="shrink-0 border-t border-fg/15 px-4 py-3 text-sm"
            >
                {{
                    deliverFailed === 'share'
                        ? i18n.exportVideo.errors.share
                        : i18n.exportVideo.errors.download
                }}
            </p>
            <ExportVideoFooter
                v-if="form !== 'land'"
                ref="footer"
                :dialog="d"
                :picker="input.env.picker"
                @export="startExport"
                @cancel="d.cancel"
                @close="close"
                @deliver="deliver"
            />
        </div>
    </BaseModal>
</template>

<style scoped>
/* Body: a grid of areas whose shape depends on the form. */
.export-grid {
    flex: 1 1 0;
    min-height: 0;
    display: grid;
}

.form-two .export-grid {
    grid-template-columns: minmax(0, 1fr) 20rem;
    grid-template-rows: minmax(0, 1fr);
}

.form-land .export-grid {
    grid-template-columns: minmax(0, 1fr) min(20rem, 45%);
    grid-template-rows: minmax(0, 1fr);
}

.form-one .export-grid {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
}

/* Short: the stage and the settings scroll together as one column. */
.form-short .export-grid {
    display: block;
    overflow-y: auto;
}

.export-side {
    display: flex;
    flex-direction: column;
    min-height: 0;
}

.export-side-edge {
    box-shadow: inset 1px 0 0 rgb(var(--color-fg) / 0.15);
}

.export-settings {
    flex: 1 1 0;
    min-height: 0;
    overflow-y: auto;
    container: export-settings / inline-size;
}

.form-short .export-settings {
    overflow: visible;
}
</style>
