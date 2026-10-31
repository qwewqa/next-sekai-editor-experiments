import { onBeforeUnmount, shallowRef } from 'vue'

// The normal and critical breakdown of a row: FieldInfo's bubble, anchored to the row. Hover (a
// mouse, or a pen hovering) or keyboard focus shows it after 400 ms; a click, tap, Enter or Space
// pins it. One is open at a time. The row that starts a wait owns it: leaving the row cancels it
// unless the row keeps focus, and a passing hover over another row resumes the focused row's
// wait when it ends. A shown bubble closes 150 ms after neither hover nor focus holds it; a pinned
// one closes on a second press, a press elsewhere, Escape, a scroll, a resize, or focus leaving
// its row for anything but the bubble.

const OPEN_DELAY_MS = 400
const CLOSE_DELAY_MS = 150

type Disclosure<K> = { key: K; how: 'shown' | 'pinned' }

/** Hover: a mouse, or a pen that hovers without touching. */
const isHover = (event: PointerEvent) =>
    event.pointerType === 'mouse' || (event.pointerType === 'pen' && event.buttons === 0)

export const useBreakdown = <K>(options: {
    /** Whether an element is the row of `key` or inside it. */
    inRow: (key: K, target: Element) => boolean
    inBubble: (target: Element) => boolean
}) => {
    const open = shallowRef<Disclosure<K>>()
    let hovered: K | undefined
    let focused: K | undefined
    let onBubble = false
    let pressingBubble = false
    let pending: { key: K; timer: ReturnType<typeof setTimeout> } | undefined
    let closeTimer: ReturnType<typeof setTimeout> | undefined

    const cancelPending = (key?: K) => {
        if (pending && (key === undefined || pending.key === key)) {
            clearTimeout(pending.timer)
            pending = undefined
        }
    }

    /** Closes the bubble; `all` also drops a pending open (Escape, a press elsewhere, a scroll). */
    const close = (all = false) => {
        clearTimeout(closeTimer)
        if (all) cancelPending()
        if (!open.value) return
        open.value = undefined
        onBubble = false
    }

    const show = (key: K, how: Disclosure<K>['how']) => {
        cancelPending()
        clearTimeout(closeTimer)
        const current = open.value
        if (current?.key === key) {
            if (how === 'pinned' && current.how !== 'pinned') open.value = { key, how }
            return
        }
        open.value = { key, how }
    }

    const holds = () => {
        const current = open.value
        return !!current && (hovered === current.key || focused === current.key || onBubble)
    }

    const reconsider = () => {
        clearTimeout(closeTimer)
        if (open.value?.how !== 'shown' || holds()) return
        closeTimer = setTimeout(() => {
            if (open.value?.how === 'shown' && !holds()) close()
        }, CLOSE_DELAY_MS)
    }

    const schedule = (key: K) => {
        if (pending?.key === key) return
        cancelPending()
        pending = {
            key,
            timer: setTimeout(() => {
                if (pending?.key === key) pending = undefined
                if (hovered === key || focused === key) show(key, 'shown')
            }, OPEN_DELAY_MS),
        }
    }

    const rowEnter = (key: K, event: PointerEvent) => {
        if (!isHover(event)) return
        hovered = key
        if (open.value?.key === key) reconsider()
        else if (open.value?.how !== 'pinned') schedule(key)
    }

    const rowLeave = (key: K, event: PointerEvent) => {
        if (!isHover(event)) return
        if (hovered === key) hovered = undefined
        if (focused !== key) cancelPending(key)
        reconsider()
        // A passing hover hands the wait back to the focused row.
        if (
            focused !== undefined &&
            focused !== key &&
            !pending &&
            open.value?.key !== focused &&
            open.value?.how !== 'pinned'
        )
            schedule(focused)
    }

    const rowFocus = (key: K, element: Element) => {
        if (!element.matches(':focus-visible')) return
        focused = key
        if (open.value?.key === key) reconsider()
        else if (open.value?.how !== 'pinned') schedule(key)
    }

    const rowBlur = (key: K, event: FocusEvent) => {
        if (focused === key) focused = undefined
        if (hovered !== key) cancelPending(key)
        if (open.value?.key !== key) return
        if (open.value.how === 'pinned') {
            const next = event.relatedTarget
            if (!pressingBubble && !(next instanceof Element && options.inBubble(next))) close()
        } else reconsider()
    }

    const rowClick = (key: K) => {
        if (open.value?.key === key && open.value.how === 'pinned') close()
        else show(key, 'pinned')
    }

    const bubbleEnter = (event: PointerEvent) => {
        if (!isHover(event)) return
        onBubble = true
        reconsider()
    }

    const bubbleLeave = (event: PointerEvent) => {
        if (!isHover(event)) return
        onBubble = false
        reconsider()
    }

    const bubbleDown = () => {
        pressingBubble = true
    }

    // --- Closing from outside, while one is open or waiting.
    const onPointerDown = (event: PointerEvent) => {
        const target = event.target
        const current = open.value
        if (!current || !(target instanceof Element)) return
        if (options.inBubble(target) || options.inRow(current.key, target)) return
        close(true)
    }
    // A touch's mousedown and blur arrive after its pointerup, so a press on the bubble lasts
    // until its click.
    const onClickEnd = () => {
        setTimeout(() => {
            pressingBubble = false
        }, 0)
    }
    const onPointerCancel = () => {
        pressingBubble = false
    }
    const onKeyDown = (event: KeyboardEvent) => {
        if (event.key !== 'Escape' || !open.value) return
        // The bubble closes, and the dialog stays; focus stays on the row.
        event.preventDefault()
        event.stopImmediatePropagation()
        close(true)
    }
    const onResize = () => {
        close(true)
    }

    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('click', onClickEnd, true)
    window.addEventListener('pointercancel', onPointerCancel, true)
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('resize', onResize)
    onBeforeUnmount(() => {
        close(true)
        window.removeEventListener('pointerdown', onPointerDown, true)
        window.removeEventListener('click', onClickEnd, true)
        window.removeEventListener('pointercancel', onPointerCancel, true)
        window.removeEventListener('keydown', onKeyDown, true)
        window.removeEventListener('resize', onResize)
    })

    return {
        open,
        close,
        rowEnter,
        rowLeave,
        rowFocus,
        rowBlur,
        rowClick,
        bubbleEnter,
        bubbleLeave,
        bubbleDown,
    }
}
