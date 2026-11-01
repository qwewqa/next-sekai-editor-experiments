<script setup lang="ts">
import {
    computed,
    nextTick,
    onBeforeUnmount,
    onMounted,
    ref,
    shallowRef,
    useTemplateRef,
    watch,
} from 'vue'
import PlayIcon from '../commands/play/PlayIcon.vue'
import ZoomXInIcon from '../commands/zooms/ZoomXInIcon.vue'
import { i18n } from '../../i18n'
import { startClipPlayer } from '../../player'
import MoreIcon from '../workspace/manager/icons/MoreIcon.vue'
import ManagerMenu, { type ManagerMenuItem } from '../workspace/manager/ManagerMenu.vue'
import ChevronIcon from '../workspace/ChevronIcon.vue'
import ClipStrip from './ClipStrip.vue'
import ClipTimeField from './ClipTimeField.vue'
import { toFrame } from './clipRange'
import { formatClipTime } from './clipTime'
import type { ExportDialog } from './dialog'
import { SetInIcon, SetOutIcon } from './icons'
import type { StageLayout } from './layout'

const props = defineProps<{
    dialog: ExportDialog
    layout: StageLayout
    peekLine?: string
}>()

const d = props.dialog
const busy = d.busy
// Read again after a wait.
const isBusy = () => d.busy.value
const frameBox = useTemplateRef<HTMLDivElement>('frameBox')
const wrap = useTemplateRef<HTMLDivElement>('wrap')
const canvas = useTemplateRef<HTMLCanvasElement>('canvas')
const zoomed = ref(false)

// --- The frame view: the output frame at the playhead, drawn by the export worker.
const wrapSize = ref({ width: 0, height: 0 })
const aspect = computed(() => d.size.value.width / d.size.value.height)
const frameSize = computed(() => {
    const { width, height } = wrapSize.value
    const w = Math.min(width, height * aspect.value)
    return { width: Math.floor(w), height: Math.floor(w / aspect.value) }
})
let context: ImageBitmapRenderingContext | null = null
const show = (bitmap: ImageBitmap) => {
    const element = canvas.value
    if (!element) {
        bitmap.close()
        return
    }
    if (element.width !== bitmap.width || element.height !== bitmap.height) {
        element.width = bitmap.width
        element.height = bitmap.height
    }
    context ??= element.getContext('bitmaprenderer')
    context?.transferFromImageBitmap(bitmap)
    hasFrame.value = true
}
d.onFrame(show)
const hasFrame = ref(false)
const loading = ref(false)
const viewError = ref<string>()
const loadingTimer = setTimeout(() => {
    if (!hasFrame.value) loading.value = true
}, 150)
// Drawing settings as a key, so a change asks for a new view.
const drawKey = computed(() => JSON.stringify(d.exportSettings()))
let requested = 0
const requestView = async () => {
    if (busy.value || viewError.value) return
    const { width, height } = frameSize.value
    if (!width || !height) return
    const ratio = window.devicePixelRatio || 1
    const at = ++requested
    d.configureView()
    const job = d.viewJob.value
    try {
        const bitmap = await job.preview(d.playhead.value, {
            width: Math.round(width * ratio),
            height: Math.round(height * ratio),
        })
        if (!bitmap) return
        if (isBusy() || at < requested - 8) bitmap.close()
        else show(bitmap)
    } catch (error) {
        if (job !== d.viewJob.value || isBusy()) return
        console.error(error)
        viewError.value = error instanceof Error ? error.message : String(error)
    }
}
// Also once an export ends, as a view asked for while it ran was refused.
watch([() => d.playhead.value, frameSize, drawKey, d.viewJob, d.busy], () => void requestView())
const retry = () => {
    viewError.value = undefined
    d.resetViewJob()
}

// --- Playback in the dialog, from the playhead to Out, with the dialog's sound.
let player: ReturnType<typeof startClipPlayer> | undefined
let frame = 0
const stop = () => {
    cancelAnimationFrame(frame)
    player?.stop()
    player = undefined
    if (d.playing.value) d.playhead.value = toFrame(d.playhead.value, d.fps(), 'down')
    d.playing.value = false
}
d.setStopPlayback(stop)
// The stop at Out and the fades follow animation frames, which a hidden page does not get.
const onVisibility = () => {
    if (document.hidden) pause()
}
document.addEventListener('visibilitychange', onVisibility)
const play = () => {
    if (busy.value) return
    if (d.playing.value) {
        stop()
        return
    }
    const { in: start, out } = d.range.value
    if (d.playhead.value < start || d.playhead.value >= out) d.playhead.value = start
    d.use('playback')
    player = startClipPlayer({
        time: d.playhead.value,
        source: d.input.snapshot,
        // The BGM is always queued, so turning it on while playing is heard.
        bgm: d.input.bgmMissing ? { offset: 0 } : d.input.bgm,
        volumes: () => {
            const fade = fadeAt(player?.time() ?? d.playhead.value)
            return {
                bgm: d.form.bgm ? d.form.bgmVolume * fade : 0,
                sfx: d.form.sfx ? d.form.sfxVolume * fade : 0,
            }
        },
        onFailure: stop,
    })
    d.playing.value = true
    const tick = () => {
        if (!player) return
        const time = player.time()
        if (time >= d.range.value.out) {
            d.playhead.value = d.range.value.out
            stop()
            return
        }
        d.playhead.value = time
        // The dialog's sound settings and the export's fades, as they are now.
        player.applyVolumes()
        frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
}
/** The export's sound fades at a chart time: 0 to 1, linear, as the mix applies them. */
const fadeAt = (time: number) => {
    const { in: start, fadeIn, fadeOut, frames, frameRate } = d.exportSettings()
    const end = start + frames / frameRate
    const rising = fadeIn > 0 ? (time - start) / fadeIn : 1
    const falling = fadeOut > 0 ? (end - time) / fadeOut : 1
    return Math.min(1, Math.max(0, Math.min(rising, falling)))
}
const pause = () => {
    if (d.playing.value) stop()
}

// --- Frame steps: one frame, repeating while held after 400 ms, up to 0.25 s a step after 1 s.
let hold: ReturnType<typeof setTimeout> | undefined
let held = false
const stepBy = (direction: -1 | 1, seconds?: number) => {
    pause()
    const fps = d.fps()
    const size = seconds === undefined ? 1 / fps : Math.max(1 / fps, toFrame(seconds, fps))
    d.playhead.value = Math.min(
        d.stripEnd,
        Math.max(0, toFrame(d.playhead.value + direction * size, fps)),
    )
}
const endHold = () => {
    clearTimeout(hold)
    hold = undefined
}
const onStepDown = (event: PointerEvent, direction: -1 | 1) => {
    if (event.button !== 0 || busy.value) return
    held = true
    stepBy(direction)
    const began = performance.now()
    const repeat = () => {
        const elapsed = performance.now() - began - 400
        // From one frame, eased up to 0.25 s a step by 1 s of repeating.
        const size = elapsed < 1000 ? undefined : 0.25
        stepBy(direction, size)
        hold = setTimeout(repeat, 50)
    }
    hold = setTimeout(repeat, 400)
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}
const onStepUp = () => {
    endHold()
}
const onStepClick = (event: MouseEvent, direction: -1 | 1) => {
    // A press already stepped; a key press clicks with no pointer.
    if (held) {
        held = false
        return
    }
    if (event.detail === 0) stepBy(direction)
}

// --- Set In, Set Out and Range.
const setIn = () => {
    pause()
    d.setClipEnd('in', d.playhead.value)
}
const setOut = () => {
    pause()
    d.setClipEnd('out', d.playhead.value)
}
const menuAnchor = shallowRef<HTMLElement>()
const menuTouch = ref(false)
const openMenu = (event: MouseEvent) => {
    if (busy.value) return
    menuAnchor.value = menuAnchor.value ? undefined : (event.currentTarget as HTMLElement)
    menuTouch.value = event instanceof PointerEvent && event.pointerType === 'touch'
}
const menuItems = computed((): ManagerMenuItem[] => [
    ...(props.layout.transportFit > 1
        ? [
              { key: 'setIn', label: i18n.value.exportVideo.setIn, icon: SetInIcon },
              { key: 'setOut', label: i18n.value.exportVideo.setOut, icon: SetOutIcon },
          ]
        : []),
    {
        key: 'whole',
        label: i18n.value.exportVideo.wholeChart,
        separated: props.layout.transportFit > 1,
        checked: d.rangeKind.value === 'whole',
    },
    {
        key: 'selection',
        label: i18n.value.exportVideo.selection,
        checked: d.rangeKind.value === 'selection',
        disabled: !d.span.value,
        description: d.span.value ? undefined : i18n.value.exportVideo.nothingSelected,
    },
])
const closeMenu = (restore: boolean) => {
    const anchor = menuAnchor.value
    menuAnchor.value = undefined
    if (restore) anchor?.focus()
}
const onMenuSelect = (key: string, keyboard: boolean) => {
    closeMenu(keyboard)
    pause()
    if (key === 'setIn') setIn()
    else if (key === 'setOut') setOut()
    else if (key === 'whole') d.useWhole()
    else if (key === 'selection') d.useSelection()
}
const toggleZoom = () => {
    zoomed.value = !zoomed.value
}

// --- In, Out and Length.
const invalidIn = ref(false)
const invalidOut = ref(false)
const lengthLabel = computed(() => i18n.value.exportVideo.length)
const lengthText = computed(() => formatClipTime(d.length.value, d.hours))
const readout = computed(() => formatClipTime(d.playhead.value, d.hours))

let wrapObserver: ResizeObserver | undefined
onMounted(() => {
    wrapObserver = new ResizeObserver(() => {
        const element = wrap.value
        if (element) wrapSize.value = { width: element.clientWidth, height: element.clientHeight }
    })
    if (wrap.value) wrapObserver.observe(wrap.value)
    void nextTick(requestView)
})
onBeforeUnmount(() => {
    document.removeEventListener('visibilitychange', onVisibility)
    stop()
    endHold()
    clearTimeout(loadingTimer)
    wrapObserver?.disconnect()
})

defineExpose({ play, pause, stepBy, setIn, setOut, frameBox })
</script>

<template>
    <section
        class="export-stage flex min-h-0 flex-col"
        :class="{ 'is-land': layout.form === 'land' }"
        data-export-stage
    >
        <p v-if="peekLine" class="-mb-1 flex h-5 shrink-0 items-center text-sm" data-export-peek>
            <span class="truncate">{{ peekLine }}</span>
        </p>
        <div
            ref="wrap"
            class="export-frame-wrap flex min-h-0 items-center justify-center"
            :class="{ 'flex-1': layout.frameHeight === undefined }"
            :style="
                layout.frameHeight === undefined ? undefined : { height: `${layout.frameHeight}px` }
            "
            data-export-frame-wrap
        >
            <div
                ref="frameBox"
                class="focus-ring relative shrink-0 overflow-hidden rounded-lg bg-black text-white"
                :style="{ width: `${frameSize.width}px`, height: `${frameSize.height}px` }"
                tabindex="0"
                role="img"
                :aria-label="i18n.exportVideo.frame"
                data-export-frame
                data-autofocus
                @click="play"
            >
                <canvas ref="canvas" class="block size-full" />
                <div
                    v-if="d.input.source === 'peek'"
                    class="pointer-events-none absolute inset-0 rounded-lg shadow-[inset_0_0_0_2px_rgb(var(--color-accent))]"
                />
                <p
                    v-if="loading && !hasFrame && !viewError"
                    class="absolute inset-0 flex items-center justify-center text-sm"
                >
                    {{ i18n.preview.loadingSkin }}
                </p>
                <div
                    v-if="viewError"
                    class="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center text-sm"
                    data-export-frame-error
                >
                    <p>{{ i18n.preview.graphicsUnavailable }}</p>
                    <button
                        type="button"
                        class="btn btn-secondary h-9 rounded-full px-4"
                        @click.stop="retry"
                    >
                        {{ i18n.save.tryAgain }}
                    </button>
                </div>
            </div>
        </div>

        <div class="flex h-9 shrink-0 items-center gap-3" data-export-transport>
            <div class="flex shrink-0 gap-2">
                <button
                    type="button"
                    class="export-hit btn btn-secondary relative flex size-9 items-center justify-center rounded-full"
                    :title="i18n.exportVideo.previousFrame"
                    :aria-label="i18n.exportVideo.previousFrame"
                    :disabled="busy"
                    data-export-previous
                    @pointerdown="onStepDown($event, -1)"
                    @pointerup="onStepUp"
                    @pointercancel="onStepUp"
                    @lostpointercapture="onStepUp"
                    @click="onStepClick($event, -1)"
                >
                    <ChevronIcon direction="left" />
                </button>
                <button
                    type="button"
                    class="export-hit btn btn-secondary relative flex size-9 items-center justify-center rounded-full"
                    :title="d.playing.value ? i18n.exportVideo.pause : i18n.exportVideo.play"
                    :aria-label="d.playing.value ? i18n.exportVideo.pause : i18n.exportVideo.play"
                    :disabled="busy"
                    data-export-play
                    @click="play"
                >
                    <PlayIcon
                        :state="d.playing.value"
                        class="size-4 fill-current"
                        aria-hidden="true"
                    />
                </button>
                <button
                    type="button"
                    class="export-hit btn btn-secondary relative flex size-9 items-center justify-center rounded-full"
                    :title="i18n.exportVideo.nextFrame"
                    :aria-label="i18n.exportVideo.nextFrame"
                    :disabled="busy"
                    data-export-next
                    @pointerdown="onStepDown($event, 1)"
                    @pointerup="onStepUp"
                    @pointercancel="onStepUp"
                    @lostpointercapture="onStepUp"
                    @click="onStepClick($event, 1)"
                >
                    <ChevronIcon direction="right" />
                </button>
            </div>
            <p
                class="shrink-0 whitespace-nowrap text-sm tabular-nums"
                :aria-label="i18n.exportVideo.playhead"
                data-export-readout
            >
                {{ readout }}
            </p>
            <div class="ml-auto flex shrink-0 gap-2" data-export-marks>
                <template v-if="layout.transportFit === 1">
                    <button
                        type="button"
                        class="export-hit btn btn-secondary relative h-9 whitespace-nowrap rounded-full px-4"
                        :disabled="busy"
                        data-export-set-in
                        @click="setIn"
                    >
                        {{ i18n.exportVideo.setIn }}
                    </button>
                    <button
                        type="button"
                        class="export-hit btn btn-secondary relative h-9 whitespace-nowrap rounded-full px-4"
                        :disabled="busy"
                        data-export-set-out
                        @click="setOut"
                    >
                        {{ i18n.exportVideo.setOut }}
                    </button>
                    <button
                        type="button"
                        class="export-hit btn btn-secondary relative flex h-9 items-center gap-2 whitespace-nowrap rounded-full pl-4 pr-3"
                        :class="{ 'is-pressed': menuAnchor }"
                        aria-haspopup="menu"
                        :aria-expanded="!!menuAnchor"
                        :disabled="busy"
                        data-export-range
                        @click="openMenu"
                    >
                        {{ i18n.exportVideo.range }}<ChevronIcon direction="down" />
                    </button>
                </template>
                <template v-else>
                    <template v-if="layout.transportFit === 2">
                        <button
                            type="button"
                            class="export-hit btn btn-secondary relative flex size-9 items-center justify-center rounded-full"
                            :title="i18n.exportVideo.setIn"
                            :aria-label="i18n.exportVideo.setIn"
                            :disabled="busy"
                            data-export-set-in
                            @click="setIn"
                        >
                            <SetInIcon class="size-4" />
                        </button>
                        <button
                            type="button"
                            class="export-hit btn btn-secondary relative flex size-9 items-center justify-center rounded-full"
                            :title="i18n.exportVideo.setOut"
                            :aria-label="i18n.exportVideo.setOut"
                            :disabled="busy"
                            data-export-set-out
                            @click="setOut"
                        >
                            <SetOutIcon class="size-4" />
                        </button>
                    </template>
                    <button
                        type="button"
                        class="export-hit btn btn-secondary relative flex size-9 items-center justify-center rounded-full"
                        :class="{ 'is-pressed': menuAnchor }"
                        :title="i18n.exportVideo.range"
                        :aria-label="i18n.exportVideo.range"
                        aria-haspopup="menu"
                        :aria-expanded="!!menuAnchor"
                        :disabled="busy"
                        data-export-range
                        @click="openMenu"
                    >
                        <MoreIcon class="size-4 fill-current" aria-hidden="true" />
                    </button>
                </template>
            </div>
        </div>
        <ManagerMenu
            v-if="menuAnchor"
            :anchor="menuAnchor"
            :label="i18n.exportVideo.range"
            :items="menuItems"
            :touch="menuTouch"
            @select="onMenuSelect"
            @close="closeMenu"
        />

        <div class="flex shrink-0 items-end gap-2" data-export-timeline>
            <ClipStrip
                :dialog
                :zoomed
                :compact="layout.compactStrip"
                :hide-ruler="layout.hideRuler"
                @scrub="pause"
            />
            <button
                type="button"
                class="export-hit btn btn-secondary btn-toggle relative flex size-9 shrink-0 items-center justify-center rounded-full"
                :style="{ marginBottom: `${((layout.compactStrip ? 48 : 56) - 36) / 2}px` }"
                :aria-pressed="zoomed"
                :title="i18n.exportVideo.zoom"
                :aria-label="i18n.exportVideo.zoom"
                data-export-zoom
                @click="toggleZoom"
            >
                <ZoomXInIcon class="size-4 fill-current" aria-hidden="true" />
            </button>
        </div>

        <div
            class="flex shrink-0 gap-x-3"
            :class="layout.form === 'land' ? 'h-8 items-center gap-x-2 text-sm' : 'items-center'"
            data-export-fields
        >
            <ClipTimeField
                :label="i18n.exportVideo.in"
                :value="d.range.value.in"
                :hours="d.hours"
                :busy
                :chip="layout.form === 'land'"
                :stacked="layout.stacked"
                @apply="(time) => d.setClipEnd('in', time)"
                @invalid="(value) => (invalidIn = value)"
            />
            <ClipTimeField
                :label="i18n.exportVideo.out"
                :value="d.range.value.out"
                :hours="d.hours"
                :busy
                :chip="layout.form === 'land'"
                :stacked="layout.stacked"
                @apply="(time) => d.setClipEnd('out', time)"
                @invalid="(value) => (invalidOut = value)"
            />
            <p
                v-if="layout.length === 'inline'"
                class="ml-1 flex items-center gap-2 whitespace-nowrap"
                :class="[
                    layout.form === 'land' ? 'text-fg/80' : 'h-9',
                    { 'self-end': layout.stacked },
                ]"
                data-export-length
            >
                <span>{{ lengthLabel }}</span
                ><span class="tabular-nums">{{ lengthText }}</span>
            </p>
        </div>
        <p
            v-if="layout.length === 'line'"
            class="-mt-2 flex h-5 shrink-0 items-center gap-2 whitespace-nowrap text-sm"
            data-export-length
        >
            <span>{{ lengthLabel }}</span
            ><span class="tabular-nums">{{ lengthText }}</span>
        </p>
        <p
            v-if="(invalidIn || invalidOut) && layout.form !== 'land'"
            role="alert"
            class="-mt-2 text-sm text-danger"
        >
            {{ i18n.exportVideo.invalidTime }}
        </p>
    </section>
</template>

<style scoped>
.export-stage {
    gap: 0.75rem;
    padding: 1rem;
}

.export-stage.is-land {
    gap: 0.5rem;
    padding-block: 0.75rem;
}

/* 44 px targets, 8 px apart, from the 36 px faces. */
.export-hit::before {
    content: '';
    position: absolute;
    inset: -0.25rem;
}
</style>
