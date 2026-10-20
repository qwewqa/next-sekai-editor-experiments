import { nextTick } from 'vue'

// Where focus goes when an action takes away the control that held it (Part 1 §1.4.10.2): to its
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

/**
 * Once the DOM has updated, focus that fell to the page goes to `opener` when it is still shown,
 * else to the chart. Focus that went anywhere else meanwhile stays.
 */
export const focusAfterRemoval = async (opener?: () => HTMLElement | null | undefined) => {
    await nextTick()
    if (!focusLost()) return
    const target = opener?.()
    if (shown(target)) target.focus({ preventScroll: true })
    // An opener that cannot take focus (disabled) leaves it to the chart.
    if (focusLost()) chartPane()?.focus({ preventScroll: true })
}
