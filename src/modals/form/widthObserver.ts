// One ResizeObserver for every field, calling back with its initial width and changes.
const callbacks = new WeakMap<Element, { width: number; callback: () => void }>()
let observer: ResizeObserver | undefined

export const observeWidth = (element: Element, callback: () => void) => {
    observer ??= new ResizeObserver((entries) => {
        for (const entry of entries) {
            const target = callbacks.get(entry.target)
            if (!target || entry.contentRect.width === target.width) continue
            target.width = entry.contentRect.width
            target.callback()
        }
    })
    // The first observer entry supplies the width without a synchronous layout during each
    // field's mount, unless the fit has recorded it already (`fittedAtWidth`). Either way a
    // dialog refits once it is visible: a fit while hidden has no width to record.
    callbacks.set(element, { width: NaN, callback })
    observer.observe(element)
}

/**
 * Records that the element was fitted at this width, so the observer's entry for the same width
 * does not fit it again. The width is the one the observer reports (the content box, as the layout
 * gives it, not scaled by a transform); NaN, as a hidden element has, leaves the first entry to refit.
 */
export const fittedAtWidth = (element: Element, width: number) => {
    const target = callbacks.get(element)
    if (target) target.width = width
}

export const unobserveWidth = (element: Element) => {
    callbacks.delete(element)
    observer?.unobserve(element)
}
