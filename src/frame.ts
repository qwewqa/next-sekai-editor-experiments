// Draws requested while the app clock's frame is being processed run at the end
// of that same frame. Through requestAnimationFrame they would land one frame
// late, where their coalescing then absorbs the next tick's request: playback
// and smooth scrolling would redraw on only every other frame.
let open: { timestamp: number; callbacks: Map<number, FrameRequestCallback> } | undefined
let nextId = -1
let clockCallbacks = false

/** `requestAnimationFrame`, joining the current clock frame when one is open. */
export const requestFrame = (callback: FrameRequestCallback) => {
    if (!open) return requestAnimationFrame(callback)
    // Negative ids never collide with requestAnimationFrame handles.
    const id = nextId--
    open.callbacks.set(id, callback)
    return id
}

export const cancelFrame = (id: number) => {
    if (id < 0) open?.callbacks.delete(id)
    else cancelAnimationFrame(id)
}

/**
 * Collects frame requests from an animation frame callback until the returned
 * function runs them. Call it before anything is rendered, e.g. once the
 * framework has flushed the updates that this frame caused.
 */
export const openFrame = (timestamp: number) => {
    const current = { timestamp, callbacks: new Map<number, FrameRequestCallback>() }
    open = current
    return () => {
        if (open === current) open = undefined
        // Later requests from these callbacks go to the next frame.
        clockCallbacks = true
        for (const callback of current.callbacks.values()) {
            try {
                callback(current.timestamp)
            } catch (error) {
                reportError(error)
            }
        }
        clockCallbacks = false
    }
}

/** Whether a draw runs for a clock tick, as playback and eased scrolling do every frame. */
export const isClockFrame = () => clockCallbacks
