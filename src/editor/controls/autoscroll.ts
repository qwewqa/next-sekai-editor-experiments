import { ref, shallowRef, watch } from 'vue'
import { bump } from '../../analytics/tally'
import { keepClockWhile, time } from '../../time'
import {
    autoscrollSpeed,
    idleAutoscroll,
    reduceAutoscroll,
    type AutoscrollEvent,
} from '../autoscroll'
import { editorNavigation, getControlBounds, type EditorNavigation } from '../navigation'
import { canScrollViewX, scrollViewXBy, scrollViewYBy, view } from '../view'
import { resizeEscapes } from './index'

type Motion = {
    anchor: { x: number; y: number }
    pointer: { x: number; y: number }
    sideways: boolean
    navigation: EditorNavigation | undefined
    size: { w: number; h: number }
}

/** Where the marker shows, while the motion runs. */
export const autoscrollMarker = shallowRef<{ x: number; y: number; sideways: boolean }>()

let state = idleAutoscroll
let motion: Motion | undefined
const running = ref(false)
keepClockWhile(() => running.value)

export const isAutoscrolling = () => running.value

const escape = () => {
    apply({ type: 'escape' })
}

const end = () => {
    motion = undefined
    running.value = false
    autoscrollMarker.value = undefined
    delete document.documentElement.dataset.autoscroll
    resizeEscapes.delete(escape)
}

const apply = (event: AutoscrollEvent) => {
    const result = reduceAutoscroll(state, event)
    const wasRunning = state.running
    state = result.state
    if (wasRunning && !state.running) end()
    return result.consume
}

/** Starts the motion at a middle press, after the press has been accepted. */
export const startAutoscroll = (event: MouseEvent) => {
    const sideways = canScrollViewX()
    const { w, h } = getControlBounds(view)
    const anchor = { x: event.clientX, y: event.clientY }
    motion = {
        anchor,
        pointer: anchor,
        sideways,
        navigation: editorNavigation.value,
        size: { w, h },
    }
    apply({ type: 'start', buttons: event.buttons })
    running.value = true
    autoscrollMarker.value = { ...anchor, sideways }
    document.documentElement.dataset.autoscroll = sideways ? 'xy' : 'y'
    resizeEscapes.add(escape)
    bump('features.autoscroll')
}

/** Owns a middle press that could not start the motion, so its release and click are consumed. */
export const refuseAutoscroll = () => {
    apply({ type: 'refuse', button: 1 })
}

export const stopAutoscroll = () => {
    apply({ type: 'stop' })
}

watch(time, ({ delta }) => {
    if (!motion) return
    const { w, h } = getControlBounds(view)
    if (
        editorNavigation.value !== motion.navigation ||
        w !== motion.size.w ||
        h !== motion.size.h
    ) {
        stopAutoscroll()
        return
    }
    const dx = motion.pointer.x - motion.anchor.x
    const dy = motion.pointer.y - motion.anchor.y
    const vy = autoscrollSpeed(dy, h)
    if (vy) scrollViewYBy(-vy * delta)
    if (motion.sideways) {
        const vx = autoscrollSpeed(dx, w)
        if (vx) scrollViewXBy(vx * delta)
    }
})

const isIdle = () => !state.running && !state.held.length && !state.trailing.length
const consumed = (event: Event, consume: boolean) => {
    if (!consume) return
    event.preventDefault()
    event.stopImmediatePropagation()
}

const onPress = (event: PointerEvent | MouseEvent) => {
    if (isIdle()) return
    if (event instanceof PointerEvent && event.pointerType !== 'mouse') {
        apply({ type: 'touch' })
        return
    }
    consumed(
        event,
        apply({
            type: 'down',
            button: event.button,
            buttons: event.buttons,
            primary: event instanceof PointerEvent,
        }),
    )
}
const onRelease = (event: PointerEvent | MouseEvent) => {
    if (isIdle()) return
    if (event instanceof PointerEvent && event.pointerType !== 'mouse') return
    consumed(event, apply({ type: 'up', button: event.button, buttons: event.buttons }))
}
const onPointerMove = (event: PointerEvent) => {
    if (isIdle() || event.pointerType !== 'mouse') return
    if (motion) motion.pointer = { x: event.clientX, y: event.clientY }
    apply({
        type: 'move',
        button: event.button,
        buttons: event.buttons,
        dx: motion ? motion.pointer.x - motion.anchor.x : 0,
        dy: motion ? motion.pointer.y - motion.anchor.y : 0,
    })
}
const onMouseMove = (event: MouseEvent) => {
    if (state.running) event.stopImmediatePropagation()
}
const onPointerCancel = (event: PointerEvent) => {
    if (isIdle() || event.pointerType !== 'mouse') return
    apply({ type: 'cancel' })
}
const onClick = (event: MouseEvent) => {
    if (isIdle()) return
    consumed(event, apply({ type: 'click', button: event.button }))
}
const onKeyDown = (event: KeyboardEvent) => {
    if (isIdle()) return
    // The running motion takes Escape through resizeEscapes.
    if (event.key === 'Escape' && state.running) return
    apply({ type: 'key', key: event.key })
}
const onWheel = () => {
    if (state.running) apply({ type: 'wheel' })
}

const listeners: [string, (event: never) => void][] = [
    ['pointerdown', onPress],
    ['mousedown', onPress],
    ['pointermove', onPointerMove],
    ['mousemove', onMouseMove],
    ['pointerup', onRelease],
    ['mouseup', onRelease],
    ['pointercancel', onPointerCancel],
    ['click', onClick],
    ['auxclick', onClick],
    ['contextmenu', onClick],
    ['keydown', onKeyDown],
    ['wheel', onWheel],
]
// Registered at load, so they run before the panes' and the minimap's own listeners.
for (const [type, listener] of listeners)
    addEventListener(type, listener as EventListener, { capture: true, passive: type === 'wheel' })
if (import.meta.hot) {
    import.meta.hot.dispose(() => {
        for (const [type, listener] of listeners)
            removeEventListener(type, listener as EventListener, true)
        end()
    })
}
