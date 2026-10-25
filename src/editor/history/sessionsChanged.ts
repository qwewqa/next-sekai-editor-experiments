// Lists that read again at once when the Delete model changes or a Delete Sessions… run ends.
// Kept out of `sessionDeleteLive` so the main chunk can signal the end of a run without loading the deletion core.

const listeners = new Set<() => void>()

/** Calls `listener` when the Delete model changes or a run ends. Returns a function that removes the listener. */
export const onDeleteChanged = (listener: () => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
}

/** Tells the lists to read again at once, after the Delete model changes or a Delete Sessions… run ends. */
export const deleteChanged = () => {
    for (const listener of listeners) listener()
}
