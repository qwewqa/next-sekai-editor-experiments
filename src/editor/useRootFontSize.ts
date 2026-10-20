import { getCurrentScope, onScopeDispose, shallowRef, type Ref } from 'vue'

// The root font size in px, kept current. Sizes set in rem follow the browser's text size on their
// own, but anything that mirrors them in script, such as a row's slot or a measured width, must be
// told when it changes. The size can change with no window resize, so a hidden 1rem box is
// observed: its width changes with the root font size, and a ResizeObserver reports it.

const read = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16

const size = shallowRef(16)
let users = 0
let probe: HTMLElement | undefined
let observer: ResizeObserver | undefined

const start = () => {
    size.value = read()
    probe = document.createElement('div')
    probe.setAttribute('aria-hidden', 'true')
    probe.style.cssText =
        'position:fixed;left:0;top:0;width:1rem;height:1px;visibility:hidden;pointer-events:none'
    document.body.append(probe)
    observer = new ResizeObserver(() => {
        const next = read()
        if (next !== size.value) size.value = next
    })
    observer.observe(probe)
}

const stop = () => {
    observer?.disconnect()
    probe?.remove()
    observer = probe = undefined
}

/**
 * The root font size in px, current while the calling scope lives. Shared: the first user starts
 * the observer and the last one stops it.
 */
export const useRootFontSize = (): Readonly<Ref<number>> => {
    if (users++ === 0) start()
    else {
        const current = read()
        if (current !== size.value) size.value = current
    }
    if (getCurrentScope())
        onScopeDispose(() => {
            if (--users === 0) stop()
        })
    return size
}
