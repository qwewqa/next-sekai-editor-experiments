import { nextTick } from 'vue'

// Where focus goes when an action takes away the control that held it: to its
// opener when that is still shown, else to the chart, so the keys never fall to the page's body.

/** Whether focus has fallen to the page: on its body or nowhere, as when its control was removed. */
export const focusLost = () => {
    const active = document.activeElement
    return !active || active === document.body
}

const shown = (element: HTMLElement | null | undefined): element is HTMLElement =>
    !!element?.isConnected && element.getClientRects().length > 0

/** The chart pane on screen. */
export const chartPane = () =>
    [...document.querySelectorAll<HTMLElement>('.chart-pane')].find((pane) => shown(pane))

const frames = (count: number) =>
    new Promise<void>((resolve) => {
        const step = (left: number) => {
            if (left <= 0) resolve()
            else
                requestAnimationFrame(() => {
                    step(left - 1)
                })
        }
        step(count)
    })

/**
 * Once the DOM has updated, focus that fell to the page goes to `opener` when it is still shown,
 * else to the chart. Focus that went anywhere else meanwhile stays.
 */
export const focusAfterRemoval = async (
    opener?: () => HTMLElement | null | undefined,
    /** Waits out the frames Chrome takes to drop focus from a control that was turned off. */
    afterFrames = false,
) => {
    await nextTick()
    if (afterFrames) await frames(2)
    if (!focusLost()) return
    const target = opener?.()
    if (shown(target)) target.focus({ preventScroll: true })
    // An opener that cannot take focus (disabled) leaves it to the chart.
    if (focusLost()) chartPane()?.focus({ preventScroll: true })
}

/**
 * Runs `run` once the press that `event` began is released, after the events its release fires,
 * so it sees where the press left focus. Call it before `swallowPress`, which hides the release
 * from listeners added after its own.
 */
export const afterPress = (event: PointerEvent, run: () => void) => {
    const { pointerId } = event
    const done = (next: PointerEvent) => {
        if (next.pointerId !== pointerId) return
        removeEventListener('pointerup', done, true)
        removeEventListener('pointercancel', done, true)
        setTimeout(run)
    }
    addEventListener('pointerup', done, true)
    addEventListener('pointercancel', done, true)
}

/** Focus that fell to the page goes back to `opener`, when it is still shown. */
export const returnFocus = (opener: HTMLElement | null | undefined) => {
    if (focusLost() && shown(opener)) opener.focus({ preventScroll: true })
}
