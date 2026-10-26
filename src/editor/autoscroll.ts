/** The pointer distance from the anchor, in CSS px, within which an axis does not scroll. */
export const DEAD_ZONE = 12

/** The fastest scroll on an axis, in lengths of the pane on that axis a second. */
const MAX_EXTENTS_PER_SECOND = 6

/** The signed scroll speed in px a second for a pointer `offset` px from the anchor. */
export const autoscrollSpeed = (offset: number, extent: number) => {
    const past = Math.abs(offset) - DEAD_ZONE
    if (past <= 0) return 0
    const speed = Math.min(8 * past + 0.06 * past * past, MAX_EXTENTS_PER_SECOND * extent)
    return Math.sign(offset) * speed
}

// The `buttons` bit of each `button` value: left, middle, right, back, forward.
const BUTTON_BITS = [1, 4, 2, 8, 16]
const MIDDLE = 1
const bitOf = (button: number) => BUTTON_BITS[button] ?? 0

export type AutoscrollState = {
    /** The motion runs. */
    running: boolean
    /** The release of the starting middle press is still to come. */
    awaiting: boolean
    /** The pointer left the dead zone during the starting press. */
    hold: boolean
    /** The mouse buttons last seen pressed, as `MouseEvent.buttons`. */
    buttons: number
    /** Owned buttons that are pressed. */
    held: readonly number[]
    /** Owned buttons that were released, whose click, auxclick or contextmenu is still to come. */
    trailing: readonly number[]
}

export type AutoscrollEvent =
    | { type: 'start'; buttons: number }
    | { type: 'refuse'; button: number }
    | { type: 'down'; button: number; buttons: number; primary: boolean }
    | { type: 'up'; button: number; buttons: number }
    | { type: 'move'; buttons: number; dx: number; dy: number }
    | { type: 'click'; button: number }
    | { type: 'key'; key: string }
    | { type: 'escape' }
    | { type: 'wheel' }
    | { type: 'touch' }
    | { type: 'cancel' }
    | { type: 'stop' }

export const idleAutoscroll: AutoscrollState = {
    running: false,
    awaiting: false,
    hold: false,
    buttons: 0,
    held: [],
    trailing: [],
}

const MODIFIER_KEYS = ['Shift', 'Control', 'Alt', 'Meta']

const stopped = (state: AutoscrollState): AutoscrollState => ({
    ...state,
    running: false,
    awaiting: false,
})
const without = (list: readonly number[], button: number) => list.filter((b) => b !== button)
const added = (list: readonly number[], button: number) =>
    list.includes(button) ? list : [...list, button]
/** An owned held button released: it trails, and the starting middle release decides click or hold. */
const release = (state: AutoscrollState, button: number): AutoscrollState => {
    const next = {
        ...state,
        held: without(state.held, button),
        trailing: added(state.trailing, button),
    }
    if (!(next.running && next.awaiting && button === MIDDLE)) return next
    return next.hold ? stopped(next) : { ...next, awaiting: false }
}

/** Returns the next state and whether the event must be consumed. */
export const reduceAutoscroll = (
    state: AutoscrollState,
    event: AutoscrollEvent,
): { state: AutoscrollState; consume: boolean } => {
    const pass = (next: AutoscrollState) => ({ state: next, consume: false })
    const consume = (next: AutoscrollState) => ({ state: next, consume: true })

    switch (event.type) {
        case 'start':
            return pass({
                running: true,
                awaiting: true,
                hold: false,
                buttons: event.buttons,
                held: [MIDDLE],
                trailing: [],
            })
        case 'refuse':
            return pass({ ...state, held: added(state.held, event.button), trailing: [] })
        case 'down': {
            // A primary press means no other button was down, so held entries are stale.
            const base = {
                ...state,
                buttons: event.buttons,
                held: event.primary ? [] : state.held,
                trailing: [],
            }
            if (base.running) {
                return consume({ ...stopped(base), held: added(base.held, event.button) })
            }
            return { state: base, consume: base.held.includes(event.button) }
        }
        case 'up': {
            const next = { ...state, buttons: event.buttons }
            if (next.trailing.includes(event.button)) return consume(next)
            if (!next.held.includes(event.button)) return pass(next)
            return consume(release(next, event.button))
        }
        case 'move': {
            const previous = state.buttons
            let next: AutoscrollState = { ...state, buttons: event.buttons }
            if (next.running) {
                if (Math.abs(event.dx) > DEAD_ZONE || Math.abs(event.dy) > DEAD_ZONE)
                    next = { ...next, hold: true }
                // A chorded press fires no pointerdown, so a button newly set in `buttons` is a press.
                const pressed = BUTTON_BITS.flatMap((bit, button) =>
                    event.buttons & ~previous & bit && !next.held.includes(button) ? [button] : [],
                )
                if (pressed.length) {
                    next = {
                        ...stopped(next),
                        held: pressed.reduce(added, next.held),
                        trailing: [],
                    }
                } else if (next.awaiting && !(event.buttons & bitOf(MIDDLE))) {
                    // The starting release never arrived.
                    next = { ...stopped(next), held: without(next.held, MIDDLE) }
                }
            }
            // A button that vanished without a reported release is released all the same.
            for (const button of next.held)
                if (!next.running && !(event.buttons & bitOf(button)) && previous & bitOf(button))
                    next = release(next, button)
            return pass(next)
        }
        case 'click': {
            const owned = state.held.includes(event.button) || state.trailing.includes(event.button)
            return {
                state: { ...state, trailing: without(state.trailing, event.button) },
                consume: owned,
            }
        }
        case 'key':
            return pass(
                MODIFIER_KEYS.includes(event.key)
                    ? { ...state, trailing: [] }
                    : { ...stopped(state), trailing: [] },
            )
        case 'escape':
            return {
                state: { ...stopped(state), trailing: [] },
                consume: state.running,
            }
        case 'wheel':
            return pass(stopped(state))
        case 'touch':
            return pass({ ...stopped(state), trailing: [] })
        case 'cancel':
            return pass({ ...stopped(state), held: [], trailing: [] })
        case 'stop':
            return pass(stopped(state))
    }
}
