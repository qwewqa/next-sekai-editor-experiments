import type { Directive } from 'vue'
import { focusAfterRemoval, focusLost, returnFocus } from '../utils/focusFallback'

/**
 * Keeps focus from falling to the page when the control that holds it goes (Part 1 §1.4.10.2).
 * On an element, or a container of controls, it acts when the focused control inside is removed
 * (an unmount) or turned off (`disabled`, which Chrome answers by dropping focus to the body).
 *
 * The value is where focus goes then, a function so it is read once the DOM has settled: its
 * element when still shown, else the chart. The default is the chart pane.
 *
 * `v-focus-rescue:return` is for a control that is turned off only while it works (a busy
 * button): focus is not moved meanwhile, and goes back to the control once it is on again, if it
 * went to the page and nowhere else.
 */
type Fallback = (() => HTMLElement | null | undefined) | undefined

const held = new WeakMap<HTMLElement, HTMLElement>()

const focusedIn = (element: HTMLElement) => {
    const active = document.activeElement
    return active instanceof HTMLElement && element.contains(active) ? active : undefined
}

export const vFocusRescue: Directive<HTMLElement, Fallback, never, 'return'> = {
    beforeUnmount(element, binding) {
        held.delete(element)
        if (focusedIn(element)) void focusAfterRemoval(binding.value)
    },
    updated(element, binding) {
        const active = focusedIn(element)
        if (active?.matches(':disabled')) {
            if (binding.arg === 'return') {
                held.set(element, active)
                return
            }
            // Moved at once, while the disabled control still holds focus, so Chrome has nothing
            // left to drop; with no target it falls to the chart once Chrome has done so.
            const target = binding.value?.()
            if (target && target !== active && target.isConnected && !target.matches(':disabled'))
                target.focus({ preventScroll: true })
            else void focusAfterRemoval(binding.value, true)
            return
        }
        const control = held.get(element)
        if (!control) return
        if (control.isConnected && control.matches(':disabled')) return
        held.delete(element)
        if (control.isConnected && focusLost()) returnFocus(control)
    },
}
