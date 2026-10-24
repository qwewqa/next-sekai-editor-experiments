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
import { backingSize } from './mapping'
import { minimapStats } from './pipeline'

// A single word reads as a native element to the linter.
defineOptions({ name: 'MinimapStrip' })

const canvas = useTemplateRef<HTMLCanvasElement>('canvas')
const annotationCanvas = useTemplateRef<HTMLCanvasElement>('annotations')
const box = useTemplateRef<HTMLElement>('box')
const cursor = useTemplateRef<HTMLElement>('cursor')
const edge = useTemplateRef<SVGElement>('edge')
const shadeAbove = useTemplateRef<HTMLElement>('shadeAbove')
const shadeBelow = useTemplateRef<HTMLElement>('shadeBelow')

/**
 * How the box (the part of the chart in view) is drawn; the owner's choice, one line:
 * - plain: a 1 px white/70 border and a white/10 fill;
 * - contrast: a 2 px white border inside a 1 px dark ring, and a white/16 fill, so it reads over
 *   light and dark notes;
 * - lens: contrast, and the strip outside the box is shaded black/30, by two strip-tall elements
 *   moved by transform with the box.
 */
const BOX_STYLE = 'plain' as 'plain' | 'contrast' | 'lens'
const boxClass = {
    plain: 'border border-white/70 bg-white/10',
    contrast: 'border-2 border-white/85 bg-white/[0.16] shadow-[0_0_0_1px_rgb(0_0_0/0.6)]',
    lens: 'border-2 border-white/85 bg-white/[0.16] shadow-[0_0_0_1px_rgb(0_0_0/0.6)]',
}[BOX_STYLE]

const { mapping } = useMinimapContent(canvas)
const { isGrabbing, onPointerDown, onPointerMove, onPointerUp, onPointerEnd, onWheel } =
    useMinimapInput(mapping)

// The box, the cursor and the edge mark move by style, outside the template: one watcher, no
// canvas work. A style is written only when its value changed, with the rows rounded to device
// pixels, so playback writes about once per pixel moved rather than once per frame.
let boxHeight = -1
let shown = false
let lastBoxTop = Number.NaN
let lastCursorY = Number.NaN
let lastShadeTop = Number.NaN
let lastShadeBottom = Number.NaN
let edgeShown = false
watch(
    [() => times.value, () => view.cursorTime, mapping, box, cursor, edge, shadeAbove, shadeBelow],
    ([, cursorTime, current, boxElement, cursorElement, edgeElement, above, below]) => {
        if (!boxElement || !cursorElement || !edgeElement) return
        const show = current !== undefined
        if (show !== shown) {
            shown = show
            boxElement.style.visibility = cursorElement.style.visibility = show ? '' : 'hidden'
            // The transforms are written again when the strip comes back.
            lastBoxTop = lastCursorY = lastShadeTop = lastShadeBottom = Number.NaN
            if (above && below)
                above.style.visibility = below.style.visibility = show ? '' : 'hidden'
            if (!show) {
                edgeShown = false
                edgeElement.style.visibility = 'hidden'
            }
        }
        if (!current) return
        const { scale } = current.geometry
        const geometry = boxGeometry(current)
        const boxTop = Math.round(geometry.top * scale) / scale
        if (boxTop !== lastBoxTop) {
            lastBoxTop = boxTop
            boxElement.style.transform = `translateY(${boxTop}px)`
        }
        // The shades are strip-tall, so they move by transform only: one ends at the box's top,
        // the other starts at its bottom.
        if (above && below) {
            const shadeTop = boxTop - current.geometry.height
            const shadeBottom = Math.round((boxTop + geometry.height) * scale) / scale
            if (shadeTop !== lastShadeTop) {
                lastShadeTop = shadeTop
                above.style.transform = `translateY(${shadeTop}px)`
            }
            if (shadeBottom !== lastShadeBottom) {
                lastShadeBottom = shadeBottom
                below.style.transform = `translateY(${shadeBottom}px)`
            }
        }
        // A layout of one element, so only when the zoom, pane or mapping changes it.
        if (geometry.height !== boxHeight) {
            boxHeight = geometry.height
            boxElement.style.height = `${geometry.height}px`
        }
        const cursorY = Math.round(current.timeToY(cursorTime) * scale) / scale
        if (cursorY !== lastCursorY) {
            lastCursorY = cursorY
            cursorElement.style.transform = `translateY(${cursorY}px)`
        }
        // The line and the box stay at the top past the last note; the mark says so.
        const past = cursorTime > current.end || times.value.max > current.end
        if (past !== edgeShown) {
            edgeShown = past
            edgeElement.style.visibility = past ? '' : 'hidden'
        }
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
            :class="{ 'z-[1]': BOX_STYLE !== 'plain' }"
        />
        <template v-if="BOX_STYLE === 'lens'">
            <div
                ref="shadeAbove"
                class="pointer-events-none absolute inset-x-0 top-0 h-full bg-black/30"
                style="visibility: hidden"
            />
            <div
                ref="shadeBelow"
                class="pointer-events-none absolute inset-x-0 top-0 h-full bg-black/30"
                style="visibility: hidden"
            />
        </template>
        <div
            ref="box"
            class="absolute inset-x-px top-0 forced-colors:border-[CanvasText]"
            :class="[boxClass, isGrabbing ? 'cursor-grabbing' : 'cursor-grab']"
            data-minimap-box
            style="visibility: hidden"
        />
        <div
            ref="cursor"
            class="pointer-events-none absolute inset-x-0 top-0 h-px bg-white"
            data-minimap-cursor
            style="visibility: hidden"
        />
        <svg
            ref="edge"
            class="pointer-events-none absolute left-[calc(50%+2px)] top-0 -translate-x-1/2 text-white forced-colors:text-[CanvasText]"
            width="11"
            height="6"
            viewBox="0 0 11 6"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            data-minimap-edge
            style="visibility: hidden"
        >
            <path d="M1 5 5.5 1 10 5" />
        </svg>
    </div>
</template>
