<script setup lang="ts">
import { useTemplateRef, watch } from 'vue'
import { times } from '..'
import { undimmed } from '../history/changes'
import { view } from '../view'
import { minimapWidth } from '../workspace'
import { useMinimapLayer } from './layers'
import { changeTicks } from './changeTicks'
import { useMinimapContent } from './content'
import { boxGeometry, useMinimapInput } from './input'
import type { MinimapMapping } from './mapping'
import { selectionMarks } from './selectionMarks'
import { timed } from '../../perf/probe'

// A single word reads as a native element to the linter.
defineOptions({ name: 'MinimapStrip' })

const canvas = useTemplateRef<HTMLCanvasElement>('canvas')
const changeCanvas = useTemplateRef<HTMLCanvasElement>('change')
const selectionCanvas = useTemplateRef<HTMLCanvasElement>('selection')
const box = useTemplateRef<HTMLElement>('box')
const cursor = useTemplateRef<HTMLElement>('cursor')
const edge = useTemplateRef<SVGElement>('edge')

const { mapping, drawn } = useMinimapContent(canvas)
const { isGrabbing, onPointerDown, onPointerMove, onPointerUp, onPointerEnd, onWheel } =
    useMinimapInput(mapping)

// The box, the cursor and the edge mark move by style, outside the template: one watcher, no
// canvas work. A style is written only when its value changed, with the rows rounded to device
// pixels, so playback writes about once per pixel moved rather than once per frame.
let boxHeight = -1
let shown = false
let lastBoxTop = Number.NaN
let lastCursorY = Number.NaN
let edgeShown = false
let edgeLeft = Number.NaN
const placeOverlay = timed(
    'minimapOverlay',
    (
        cursorTime: number,
        current: MinimapMapping | undefined,
        boxElement: HTMLElement | null,
        cursorElement: HTMLElement | null,
        edgeElement: HTMLElement | SVGElement | null,
    ) => {
        if (!boxElement || !cursorElement || !edgeElement) return
        const show = current !== undefined
        if (show !== shown) {
            shown = show
            boxElement.style.visibility = cursorElement.style.visibility = show ? '' : 'hidden'
            // The transforms are written again when the strip comes back.
            lastBoxTop = lastCursorY = Number.NaN
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
        // The mark's apex is 5.5 px into it, so a whole-pixel left keeps the tip one pixel wide: on
        // the strip's middle, or half a pixel right of it at an even width.
        const left = Math.ceil(current.geometry.width / 2 - 5.5)
        if (left !== edgeLeft) {
            edgeLeft = left
            edgeElement.style.left = `${left}px`
        }
        // The line and the box stay at the top past the last note; the mark says so.
        const past = cursorTime > current.end || times.value.max > current.end
        if (past !== edgeShown) {
            edgeShown = past
            edgeElement.style.visibility = past ? '' : 'hidden'
        }
    },
)
watch(
    [() => times.value, () => view.cursorTime, mapping, box, cursor, edge],
    ([, cursorTime, current, boxElement, cursorElement, edgeElement]) => {
        placeOverlay(cursorTime, current, boxElement, cursorElement, edgeElement)
    },
    { flush: 'post' },
)

// The mark layers, bottom to top: History's change ticks, then the selection.
const { active: hasChanges } = useMinimapLayer(changeCanvas, mapping, drawn, changeTicks)
const { active: hasSelection } = useMinimapLayer(selectionCanvas, mapping, drawn, selectionMarks)
</script>

<template>
    <div
        class="relative flex-none touch-none select-none overflow-hidden bg-bg"
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
            v-if="hasChanges"
            ref="change"
            class="pointer-events-none absolute inset-0 z-1 size-full"
            data-minimap-layer="change"
        />
        <canvas
            v-if="hasSelection"
            ref="selection"
            class="pointer-events-none absolute inset-0 z-2 size-full"
            data-minimap-layer="selection"
        />
        <div
            ref="box"
            class="absolute left-[6px] right-[6px] top-0 z-3 border-2 border-white/85 bg-white/16 shadow-[0_0_0_1px_rgb(0_0_0/0.6)] forced-colors:border-[CanvasText]"
            :class="isGrabbing ? 'cursor-grabbing' : 'cursor-grab'"
            data-minimap-box
            style="visibility: hidden"
        />
        <div
            ref="cursor"
            class="pointer-events-none absolute inset-x-0 top-0 z-3 h-px bg-white"
            data-minimap-cursor
            style="visibility: hidden"
        />
        <svg
            ref="edge"
            class="pointer-events-none absolute top-1 z-3 text-white forced-colors:text-[CanvasText]"
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
