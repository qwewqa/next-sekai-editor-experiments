<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue'
import { interruptsDrags } from '../../activity'
import { resizeEscapes } from '../controls'
import { cancelMouseControls } from '../controls/mouse'
import { cancelTouchControls } from '../controls/touch'

const props = defineProps<{
    /** `x` separates side by side areas; `y` separates stacked areas. */
    axis: 'x' | 'y'
    label: string
    value: number
    min: number
    max: number
}>()

const emit = defineEmits<{
    start: []
    /** Pointer movement since the drag started, in CSS pixels. */
    move: [delta: number]
    end: []
    cancel: []
    /** Keyboard adjustment relative to the current value. */
    step: [delta: number]
    set: [value: number]
    reset: []
}>()

const isDragging = ref(false)
let drag: { pointerId: number; origin: number; element: HTMLElement } | undefined

const coordinate = (event: PointerEvent) => (props.axis === 'x' ? event.clientX : event.clientY)

const stop = () => {
    resizeEscapes.delete(cancel)
    if (drag?.element.hasPointerCapture(drag.pointerId))
        drag.element.releasePointerCapture(drag.pointerId)
    drag = undefined
    isDragging.value = false
}

const cancel = () => {
    if (!drag) return
    stop()
    emit('cancel')
}

const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || drag) return
    cancelMouseControls()
    cancelTouchControls()
    const element = event.currentTarget as HTMLElement
    drag = { pointerId: event.pointerId, origin: coordinate(event), element }
    isDragging.value = true
    element.setPointerCapture(event.pointerId)
    resizeEscapes.add(cancel)
    emit('start')
}

const onPointerMove = (event: PointerEvent) => {
    if (event.pointerId !== drag?.pointerId) return
    emit('move', coordinate(event) - drag.origin)
}

const finish = (event: PointerEvent) => {
    if (event.pointerId !== drag?.pointerId) return
    stop()
    // A cancelled pointer or lost capture restores the saved preference.
    if (event.type === 'pointerup') emit('end')
    else emit('cancel')
}

const onKeydown = (event: KeyboardEvent) => {
    const step = event.shiftKey ? 64 : 16
    const back = props.axis === 'x' ? 'ArrowLeft' : 'ArrowUp'
    const forward = props.axis === 'x' ? 'ArrowRight' : 'ArrowDown'
    if (event.key === back) emit('step', -step)
    else if (event.key === forward) emit('step', step)
    else if (event.key === 'Home') emit('set', props.min)
    else if (event.key === 'End') emit('set', props.max)
    else if (event.key === 'Enter') emit('reset')
    else return
    event.preventDefault()
}

const onClick = (event: MouseEvent) => {
    // Pointer interactions return keyboard shortcuts to the editor.
    if (event.detail > 0) (event.currentTarget as HTMLElement).blur()
}

// Leaving the app or a blocking dialog mid-drag may never deliver the release.
watch(interruptsDrags, (interrupted) => {
    if (interrupted) cancel()
})

/** Ends a drag in progress as Escape does. */
defineExpose({ cancel })

onUnmounted(() => {
    if (!drag) return
    stop()
    emit('cancel')
})
</script>

<template>
    <div
        class="resize-handle group absolute z-20 flex touch-none items-center justify-center"
        :class="[
            axis === 'x'
                ? 'inset-y-0 w-3 -translate-x-1/2 cursor-col-resize'
                : 'inset-x-0 h-3 -translate-y-1/2 cursor-row-resize',
            { 'is-dragging': isDragging },
        ]"
        role="separator"
        tabindex="0"
        :aria-orientation="axis === 'x' ? 'vertical' : 'horizontal'"
        :aria-label="label"
        :title="label"
        :aria-valuemin="Math.round(min)"
        :aria-valuemax="Math.round(max)"
        :aria-valuenow="Math.round(value)"
        @pointerdown.stop.prevent="onPointerDown"
        @pointermove.stop="onPointerMove"
        @pointerup.stop="finish"
        @pointercancel.stop="finish"
        @lostpointercapture="finish"
        @keydown.stop="onKeydown"
        @click="onClick"
        @dblclick="emit('reset')"
    >
        <div
            class="resize-line pointer-events-none absolute transition-colors"
            :class="
                axis === 'x'
                    ? 'inset-y-0 left-1/2 w-[3px] -translate-x-1/2'
                    : 'inset-x-0 top-1/2 h-[3px] -translate-y-1/2'
            "
        />
        <div
            class="resize-grabber pointer-events-none relative rounded-full bg-knob shadow ring-1 ring-fg/25 transition-opacity"
            :class="axis === 'x' ? 'h-8 w-1' : 'h-1 w-8'"
        />
    </div>
</template>

<style scoped>
/* Scoped rather than the utility, whose transparent outline forced colours paint as a resting edge. */
.resize-handle {
    outline: none;
}

/* High contrast drops the line's fill, so the keyboard focus shows as a 4px outline, as on other controls. */
@media (forced-colors: active) {
    .resize-handle:focus-visible {
        outline: 4px solid Highlight;
    }
}

.resize-grabber {
    opacity: 0;
}

/* The line takes the dark chrome's ink: a step when hovered, full when dragged or focused. A drag
   is a press, and mint means on, so there is no mint here. The dragged or focused look comes last
   so it wins over hover while the pointer is still on the line. */
@media (hover: hover) {
    .resize-handle:hover .resize-line {
        @apply bg-white/60;
    }

    .resize-handle:hover .resize-grabber {
        opacity: 1;
    }
}

.resize-handle:focus-visible .resize-line,
.resize-handle.is-dragging .resize-line {
    @apply bg-white;
}

.resize-handle:focus-visible .resize-grabber,
.resize-handle.is-dragging .resize-grabber {
    opacity: 1;
}

/* Touch has no hover, so the grabber always shows where to drag. */
@media (pointer: coarse) {
    .resize-grabber {
        opacity: 1;
    }
}
</style>
