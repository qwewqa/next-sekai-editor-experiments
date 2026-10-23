import { onBeforeUnmount, ref, type Ref } from 'vue'
import { times } from '..'
import { settings } from '../../settings'
import { activateEditorNavigation, resizeEscapes } from '../controls'
import { isDragging } from '../controls/gestures/recognizers/drag'
import { cancelPreviewFollow, stopPlayer } from '../player'
import { scrollViewYBy, updateViewLastActive, view } from '../view'
import type { MinimapMapping } from './mapping'

/** A touch that moves this many CSS px is a slide, not a tap. */
const SLIDE = 8
/** A box shorter than this is grabbed within half of it of its centre. */
const SMALL_BOX = 24
const MIN_BOX = 8

/** The box in CSS px from the strip's top: the view's range, at least `MIN_BOX` tall, kept inside the strip. */
export const boxGeometry = (mapping: MinimapMapping) => {
    const top = mapping.timeToY(times.value.max)
    const bottom = mapping.timeToY(times.value.min)
    const height = Math.min(mapping.geometry.height, Math.max(MIN_BOX, bottom - top))
    const centre = (top + bottom) / 2
    return {
        top: Math.max(0, Math.min(mapping.geometry.height - height, centre - height / 2)),
        height,
    }
}

type Press = {
    pointerId: number
    element: HTMLElement
    /** The strip's rect when the press began. */
    rect: DOMRect
    /** `view.time` when the press began, which Escape restores. */
    start: number
    /** How far below the row of `view.time` the pointer holds the box; undefined until grabbed. */
    offset: number | undefined
    /** A touch press off the box: it jumps on release, unless it slides. */
    tap: { x: number; y: number } | undefined
}

/**
 * The strip's press, drag, wheel and Escape (Part 1 §1.4.22). It writes only `view.time` and the
 * scroll and active fields; it never edits the chart or leaves a peek.
 */
export const useMinimapInput = (mapping: Readonly<Ref<MinimapMapping | undefined>>) => {
    const isGrabbing = ref(false)
    let press: Press | undefined

    const end = () => {
        if (!press) return
        const { element, pointerId } = press
        press = undefined
        isGrabbing.value = false
        resizeEscapes.delete(cancel)
        if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId)
    }

    // Escape puts the view back and ends the press, before any Deselect or drawer sees the key.
    const cancel = () => {
        if (!press) return
        view.time = press.start
        end()
    }

    const jumpTo = (y: number) => {
        if (mapping.value) view.time = mapping.value.yToTime(y)
    }

    const onPointerDown = (event: PointerEvent) => {
        const current = mapping.value
        if (!current || press || isDragging.value || !event.isPrimary) return
        if (event.pointerType === 'mouse' && event.button !== 0) return
        if (!activateEditorNavigation()) return

        const element = event.currentTarget as HTMLElement
        stopPlayer(false)
        view.scrollingX = undefined
        view.scrollingY = undefined
        view.scrollingPane = undefined
        updateViewLastActive()

        element.setPointerCapture(event.pointerId)
        const rect = element.getBoundingClientRect()
        press = {
            pointerId: event.pointerId,
            element,
            rect,
            start: view.time,
            offset: undefined,
            tap: undefined,
        }
        resizeEscapes.add(cancel)

        const y = event.clientY - rect.top
        const box = boxGeometry(current)
        const onBox =
            box.height < SMALL_BOX
                ? Math.abs(y - (box.top + box.height / 2)) <= SMALL_BOX / 2
                : y >= box.top && y <= box.top + box.height
        if (onBox) {
            // Held from the row of the view's time, which the box only matches away from time 0.
            press.offset = y - current.timeToY(view.time)
            isGrabbing.value = true
        } else if (event.pointerType === 'mouse') {
            jumpTo(y)
            press.offset = 0
            isGrabbing.value = true
        } else {
            press.tap = { x: event.clientX, y: event.clientY }
        }
    }

    const onPointerMove = (event: PointerEvent) => {
        if (event.pointerId !== press?.pointerId) return
        if (press.tap) {
            // A slide off the box does nothing: an edge swipe must not throw the view.
            if (Math.hypot(event.clientX - press.tap.x, event.clientY - press.tap.y) >= SLIDE) end()
            return
        }
        if (press.offset !== undefined && mapping.value)
            view.time = mapping.value.yToTime(event.clientY - press.rect.top - press.offset)
    }

    const onPointerUp = (event: PointerEvent) => {
        if (event.pointerId !== press?.pointerId) return
        if (press.tap) jumpTo(press.tap.y - press.rect.top)
        end()
    }

    const onPointerEnd = (event: PointerEvent) => {
        if (press?.pointerId === event.pointerId) end()
    }

    const onWheel = (event: WheelEvent) => {
        if (event.ctrlKey || event.shiftKey || !event.deltaY) return
        // The Elevation Editor may hold the navigation; the strip always scrolls the main chart.
        if (!activateEditorNavigation()) return
        cancelPreviewFollow()
        const unit =
            event.deltaMode === WheelEvent.DOM_DELTA_LINE
                ? 20
                : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
                  ? view.h
                  : 1
        scrollViewYBy(-event.deltaY * unit, settings.mouseSmoothScrolling)
    }

    // The strip can unmount mid-press; a dead `cancel` would swallow every Escape.
    onBeforeUnmount(end)

    return { isGrabbing, onPointerDown, onPointerMove, onPointerUp, onPointerEnd, onWheel }
}
