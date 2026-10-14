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
    // The first observer entry supplies the width without a synchronous layout
    // during each field's mount. It also refits a dialog once it is visible.
    callbacks.set(element, { width: NaN, callback })
    observer.observe(element)
}

export const unobserveWidth = (element: Element) => {
    callbacks.delete(element)
    observer?.unobserve(element)
}
