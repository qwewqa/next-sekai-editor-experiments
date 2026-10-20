import { recordError } from '../diagnostics'

const listeners = new Set<() => void>()

/** Calls `listener` once, when storing starts and the flusher exists. Returns the way to cancel. */
export const onFlusherStart = (listener: () => void) => {
    const once = () => {
        listeners.delete(once)
        listener()
    }
    listeners.add(once)
    return () => void listeners.delete(once)
}

/**
 * Runs the start listeners, each alone: a UI subscriber that throws is recorded and never stops
 * the others, or the storing setup that called this.
 */
export const notifyFlusherStart = () => {
    for (const listener of [...listeners]) {
        try {
            listener()
        } catch (error) {
            recordError(error)
        }
    }
}
