// The lists that read again at once when the Delete model changes or a Delete Sessions… run ends.
// Apart from `sessionDeleteLive`, so the main chunk can announce a run without loading the deletion core.

const listeners = new Set<() => void>()

/** Lists read again when sessions change; returns how to stop. */
export const onDeleteChanged = (listener: () => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
}

/** Lists read again at once: the model changed, or a Delete Sessions… run ended. */
export const deleteChanged = () => {
    for (const listener of listeners) listener()
}
