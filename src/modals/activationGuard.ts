/** Activations within this long of a dialog opening are ignored. */
export const GUARD_MS = 300

/** A press within the first moments, or a held key, is not a choice. Call during setup. */
export const useActivationGuard = () => {
    const openedAt = performance.now()
    return {
        accidental: () => performance.now() - openedAt < GUARD_MS,
        /** On the button row, in the capture phase: key repeat never reaches the focused button. */
        onKeydown: (event: KeyboardEvent) => {
            if (event.repeat && (event.key === 'Enter' || event.key === ' ')) {
                event.preventDefault()
                event.stopPropagation()
            }
        },
    }
}
