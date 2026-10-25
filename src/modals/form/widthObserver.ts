// One ResizeObserver for every field, calling back with its initial width and changes.
const callbacks = new WeakMap<Element, { width: number; callback: () => void }>()
let observer: ResizeObserver | undefined

export const observeWidth = (element: Element, callback: () => void) => {
    observer ??= new ResizeObserver((entries) => {
        for (const entry of entries) {
            const target = callbacks.get(entry.target)
            // `getComputedStyle` rounds to six significant digits, so a recorded width can differ from
            // the observer's by a fraction of a pixel. A NaN width (not fitted yet) is never within
            // the tolerance, so it refits.
            if (!target || Math.abs(entry.contentRect.width - target.width) < 0.01) continue
            target.width = entry.contentRect.width
            target.callback()
        }
    })
    // The first observer entry supplies the width without a synchronous layout during each
    // field's mount, unless the fit has recorded it already (`fittedAtWidth`). A fit in a hidden
    // dialog records no width, so its fields refit once it is visible.
    callbacks.set(element, { width: NaN, callback })
    observer.observe(element)
}

/**
 * Records that the element was fitted at this width, so the observer's entry for the same width
 * does not fit it again. The width is the one the observer reports (the content box, as the layout
 * gives it, not scaled by a transform). A hidden element gives NaN, and the first entry then refits.
 */
export const fittedAtWidth = (element: Element, width: number) => {
    const target = callbacks.get(element)
    if (target) target.width = width
}

export const unobserveWidth = (element: Element) => {
    callbacks.delete(element)
    observer?.unobserve(element)
}
