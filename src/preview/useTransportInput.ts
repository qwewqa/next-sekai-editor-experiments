import { onUnmounted, ref, watch, type Ref } from 'vue'
import { interruptsDrags, isAppActive } from '../activity'
import {
    beginPreviewScrub,
    endPreviewScrub,
    scrubPreviewTo,
    stepPreviewTime,
} from '../editor/player'
import { view } from '../editor/view'
import { isPlaying } from '../player'
import { keepClockWhile, time } from '../time'

// A drag across the image seeks a second per image width, past a slop that keeps taps taps.
const dragSlop = 8

export const useTransportInput = (visible: Ref<boolean>, imageWidth: () => number) => {
    const activeStep = ref<number>()

    type Hold = {
        milliseconds: number
        target: HTMLButtonElement
        scrub?: { cursor: number; time: number }
    } & ({ type: 'pointer'; pointerId: number } | { type: 'keyboard'; key: string })

    let hold: Hold | undefined
    let holdDelay: ReturnType<typeof setTimeout> | undefined
    let stopScrubClock: (() => void) | undefined
    let wheelDelay: ReturnType<typeof setTimeout> | undefined
    let isWheelScrubbing = false
    let wheelRoot: HTMLElement | undefined

    const finishHold = (audition: boolean) => {
        const current = hold
        if (!current) return
        hold = undefined
        activeStep.value = undefined
        clearTimeout(holdDelay)
        holdDelay = undefined
        stopScrubClock?.()
        stopScrubClock = undefined
        if (current.scrub) endPreviewScrub(audition && isAppActive.value)
        if (current.type === 'pointer') {
            if (current.target.hasPointerCapture(current.pointerId)) {
                current.target.releasePointerCapture(current.pointerId)
            }
            current.target.blur()
        }
    }

    const finishWheel = (audition: boolean) => {
        clearTimeout(wheelDelay)
        wheelDelay = undefined
        document.removeEventListener('pointerdown', onWheelOutsidePointerDown, true)
        wheelRoot = undefined
        if (!isWheelScrubbing) return
        isWheelScrubbing = false
        endPreviewScrub(audition && isAppActive.value)
    }

    const onWheelOutsidePointerDown = (event: PointerEvent) => {
        if (event.target instanceof Node && !wheelRoot?.contains(event.target)) finishWheel(false)
    }

    const onWheel = (event: WheelEvent) => {
        // Firefox can change legacy wheel units when deltaY is accessed first.
        const mode = event.deltaMode
        const delta = event.deltaY
        if (event.ctrlKey || !isAppActive.value || !Number.isFinite(delta) || !delta) return

        const pixels =
            delta *
            (mode === WheelEvent.DOM_DELTA_LINE
                ? 16
                : mode === WheelEvent.DOM_DELTA_PAGE
                  ? (event.currentTarget as HTMLElement).clientHeight
                  : 1)
        event.preventDefault()
        event.stopPropagation()
        // A seek drag holds the scrub until it ends.
        if (isSeekDragging.value) return
        finishHold(false)
        if (!isWheelScrubbing) {
            beginPreviewScrub('locked')
            isWheelScrubbing = true
            wheelRoot = event.currentTarget as HTMLElement
            // A subsequent editor click must retain its normal note audition.
            document.addEventListener('pointerdown', onWheelOutsidePointerDown, true)
        }
        scrubPreviewTo(view.cursorTime - pixels / 1000)
        // Trackpads can emit several events per frame. Keep them silent and audition
        // only the final position after the gesture settles.
        clearTimeout(wheelDelay)
        wheelDelay = setTimeout(() => {
            finishWheel(true)
        }, 120)
    }

    type Drag = { pointerId: number; x: number; y: number; cursor: number; target: HTMLElement }
    let drag: Drag | undefined
    const isSeekDragging = ref(false)
    // A drag's release may also click the toggle under it, just after.
    let dragged = false

    const finishDrag = (audition: boolean) => {
        const current = drag
        if (!current) return
        drag = undefined
        window.removeEventListener('pointerup', onDragRelease, true)
        window.removeEventListener('pointercancel', onDragRelease, true)
        if (current.target.hasPointerCapture(current.pointerId))
            current.target.releasePointerCapture(current.pointerId)
        if (!isSeekDragging.value) return
        isSeekDragging.value = false
        endPreviewScrub(audition && isAppActive.value)
        // The press focused what it landed on; shortcuts return to the editor, as after a click.
        const focused = document.activeElement
        if (focused instanceof HTMLElement && current.target.contains(focused)) focused.blur()
        dragged = true
        setTimeout(() => (dragged = false))
    }

    // On the window, as a release outside comes before capture would bring it here.
    const onDragRelease = (event: PointerEvent) => {
        if (drag?.pointerId === event.pointerId) finishDrag(event.type === 'pointerup')
    }

    const onSurfacePointerDown = (event: PointerEvent) => {
        if (event.button !== 0 || !event.isPrimary || drag || hold || !isAppActive.value) return
        drag = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            cursor: view.cursorTime,
            target: event.currentTarget as HTMLElement,
        }
        window.addEventListener('pointerup', onDragRelease, true)
        window.addEventListener('pointercancel', onDragRelease, true)
    }

    const onSurfacePointerMove = (event: PointerEvent) => {
        if (drag?.pointerId !== event.pointerId) return
        // Released where no release reaches the page, as outside the window.
        if (!event.buttons) {
            finishDrag(false)
            return
        }
        const dx = event.clientX - drag.x
        if (!isSeekDragging.value) {
            const dy = event.clientY - drag.y
            if (Math.hypot(dx, dy) <= dragSlop) return
            // Its way past the slop decides: a mostly vertical press never seeks, nor
            // one while a step is held.
            if (Math.abs(dx) < Math.abs(dy) || hold) {
                finishDrag(false)
                return
            }
            finishWheel(false)
            beginPreviewScrub('locked')
            // From where it starts, so seeking begins at zero and runs straight both ways.
            drag.cursor = view.cursorTime
            drag.x = event.clientX
            drag.target.setPointerCapture(event.pointerId)
            isSeekDragging.value = true
        }
        const width = imageWidth()
        if (width > 0) scrubPreviewTo(drag.cursor + (event.clientX - drag.x) / width)
    }

    const onSurfaceCaptureLost = (event: PointerEvent) => {
        if (drag?.pointerId === event.pointerId) finishDrag(false)
    }

    /** Whether a pointer click comes from a seek drag's release, which then takes it. */
    const takeDragClick = (event: MouseEvent) => {
        const was = dragged && event.detail > 0
        dragged = false
        return was
    }

    const startHold = (current: Hold) => {
        if (hold || isSeekDragging.value || !isAppActive.value) return false
        // A press that hasn't begun seeking gives way.
        finishDrag(false)
        finishWheel(false)
        stepPreviewTime(current.milliseconds)
        hold = current
        activeStep.value = current.milliseconds
        // A short tap remains one exact step. Holding then scrubs at 100 steps/s,
        // using elapsed time instead of an interval or a backlog of repeated taps.
        holdDelay = setTimeout(() => {
            holdDelay = undefined
            if (hold !== current || !isAppActive.value) return
            beginPreviewScrub('locked')
            current.scrub = { cursor: view.cursorTime, time: performance.now() / 1000 }
            const stopScrub = watch(time, ({ now }) => {
                if (hold !== current || !current.scrub) return
                scrubPreviewTo(
                    current.scrub.cursor +
                        (Math.max(0, now - current.scrub.time) * current.milliseconds) / 10,
                )
            })
            // Until the hold ends.
            const releaseClock = keepClockWhile(() => true)
            stopScrubClock = () => {
                stopScrub()
                releaseClock()
            }
        }, 250)
        return true
    }

    const onPointerDown = (event: PointerEvent, milliseconds: number) => {
        if (event.button !== 0 || !event.isPrimary) return
        if (hold?.type === 'keyboard') finishHold(false)
        const target = event.currentTarget as HTMLButtonElement
        if (startHold({ type: 'pointer', pointerId: event.pointerId, target, milliseconds })) {
            target.setPointerCapture(event.pointerId)
        }
    }

    const onPointerUp = (event: PointerEvent) => {
        if (hold?.type === 'pointer' && hold.pointerId === event.pointerId) finishHold(true)
    }

    const onPointerCancel = (event: PointerEvent) => {
        if (hold?.type === 'pointer' && hold.pointerId === event.pointerId) finishHold(false)
    }

    const onStepKeydown = (event: KeyboardEvent, milliseconds: number) => {
        if (event.key !== ' ' && event.key !== 'Enter') return
        event.preventDefault()
        if (event.repeat) return
        startHold({
            type: 'keyboard',
            key: event.key,
            target: event.currentTarget as HTMLButtonElement,
            milliseconds,
        })
    }

    const onStepKeyup = (event: KeyboardEvent) => {
        if (event.key !== ' ' && event.key !== 'Enter') return
        event.preventDefault()
        if (hold?.type === 'keyboard' && hold.key === event.key) finishHold(true)
    }

    const onStepBlur = (event: FocusEvent) => {
        if (hold?.type === 'keyboard' && hold.target === event.currentTarget) finishHold(false)
    }

    const onStepClick = (event: MouseEvent, milliseconds: number) => {
        // Pointer and keyboard presses are handled above. Assistive technology can
        // activate a button with a click alone and still gets one exact step.
        if (!event.detail && !hold) {
            finishWheel(false)
            stepPreviewTime(milliseconds)
        }
    }

    watch(
        [visible, isPlaying, interruptsDrags],
        ([shown, playing, interrupted], [wasShown]) => {
            if (!shown || playing || interrupted) finishHold(false)
            if (playing || interrupted) finishDrag(false)
            // Seeking also works with the controls hidden. Only a transition to
            // hidden, playback, or an interruption cancels an active wheel gesture.
            if ((wasShown && !shown) || playing || interrupted) finishWheel(false)
        },
        { flush: 'sync' },
    )

    onUnmounted(() => {
        finishHold(false)
        finishWheel(false)
        finishDrag(false)
    })
    return {
        activeStep,
        isSeekDragging,
        onSurfacePointerDown,
        onSurfacePointerMove,
        onSurfaceCaptureLost,
        takeDragClick,
        onWheel,
        onPointerDown,
        onPointerUp,
        onPointerCancel,
        onStepKeydown,
        onStepKeyup,
        onStepBlur,
        onStepClick,
        cancel: () => {
            finishHold(false)
            finishWheel(false)
            finishDrag(false)
        },
    }
}
