<script setup lang="ts">
import { computed, onBeforeUnmount, useTemplateRef, watch } from 'vue'
import { times } from '..'
import { undimmed } from '../history/changes'
import { view } from '../view'
import { minimapWidth } from '../workspace'
import type { MinimapAnnotation } from './annotations'
import { changeTicks } from './changeTicks'
import { useMinimapContent } from './content'
import { boxGeometry, useMinimapInput } from './input'
import { backingSize, type MinimapMapping } from './mapping'
import { minimapStats } from './pipeline'
import { timed } from '../../perf/probe'

// A single word reads as a native element to the linter.
defineOptions({ name: 'MinimapStrip' })

const canvas = useTemplateRef<HTMLCanvasElement>('canvas')
const annotationCanvas = useTemplateRef<HTMLCanvasElement>('annotations')
const box = useTemplateRef<HTMLElement>('box')
const cursor = useTemplateRef<HTMLElement>('cursor')

const { mapping } = useMinimapContent(canvas)
const { isGrabbing, onPointerDown, onPointerMove, onPointerUp, onPointerEnd, onWheel } =
    useMinimapInput(mapping)

// The box and the cursor move by style, outside the template: one watcher, no canvas work.
let boxHeight = -1
const placeOverlay = timed(
    'minimapOverlay',
    (
        cursorTime: number,
        current: MinimapMapping | undefined,
        boxElement: HTMLElement | null,
        cursorElement: HTMLElement | null,
    ) => {
        if (!boxElement || !cursorElement) return
        boxElement.style.visibility = cursorElement.style.visibility = current ? '' : 'hidden'
        if (!current) return
        const geometry = boxGeometry(current)
        boxElement.style.transform = `translateY(${geometry.top}px)`
        // A layout of one element, so only when the zoom, pane or mapping changes it.
        if (geometry.height !== boxHeight) {
            boxHeight = geometry.height
            boxElement.style.height = `${geometry.height}px`
        }
        cursorElement.style.transform = `translateY(${current.timeToY(cursorTime)}px)`
    },
)
watch(
    [() => times.value, () => view.cursorTime, mapping, box, cursor],
    ([, cursorTime, current, boxElement, cursorElement]) => {
        placeOverlay(cursorTime, current, boxElement, cursorElement)
    },
    { flush: 'post' },
)

// The annotation painters are a static list (Part 1 §1.4.22).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const painters: MinimapAnnotation<any>[] = [changeTicks]

// The canvas exists only while a painter has something to draw.
const hasAnnotations = computed(() => painters.some((painter) => painter.inputs() !== undefined))

watch(
    [hasAnnotations, mapping, ...painters.map((painter) => painter.inputs)],
    () => {
        const element = annotationCanvas.value
        const current = mapping.value
        if (!element || !current) return
        const size = backingSize(current.geometry)
        if (element.width !== size.width) element.width = size.width
        if (element.height !== size.height) element.height = size.height
        const ctx = element.getContext('2d')
        if (!ctx) return
        ctx.setTransform(
            size.width / current.geometry.width,
            0,
            0,
            size.height / current.geometry.height,
            0,
            0,
        )
        ctx.clearRect(0, 0, current.geometry.width, current.geometry.height)
        for (const painter of painters) {
            const inputs: unknown = painter.inputs()
            if (inputs !== undefined) painter.paint(ctx, current, inputs)
        }
        minimapStats.annotationPaints++
    },
    { flush: 'post' },
)

onBeforeUnmount(() => {
    if (annotationCanvas.value) annotationCanvas.value.width = annotationCanvas.value.height = 0
})
</script>

<template>
    <div
        class="relative flex-none touch-none select-none overflow-hidden bg-bg shadow-[inset_1px_0_0_rgb(255_255_255/0.1)]"
        :class="isGrabbing ? 'cursor-grabbing' : 'cursor-pointer'"
        :style="{ width: `${minimapWidth}px` }"
        aria-hidden="true"
        data-minimap
        @mousedown.prevent
        @contextmenu.prevent
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerEnd"
        @lostpointercapture="onPointerEnd"
        @wheel.prevent="onWheel"
    >
        <canvas
            ref="canvas"
            class="absolute inset-0 size-full"
            :style="{ opacity: undimmed !== undefined ? 0.45 : undefined }"
        />
        <canvas
            v-if="hasAnnotations"
            ref="annotations"
            class="pointer-events-none absolute inset-0 size-full"
        />
        <div
            ref="box"
            class="absolute inset-x-px top-0 border border-white/70 bg-white/10 forced-colors:border-[CanvasText]"
            :class="isGrabbing ? 'cursor-grabbing' : 'cursor-grab'"
            data-minimap-box
            style="visibility: hidden"
        />
        <div
            ref="cursor"
            class="pointer-events-none absolute inset-x-0 top-0 h-px bg-white"
            data-minimap-cursor
            style="visibility: hidden"
        />
    </div>
</template>
