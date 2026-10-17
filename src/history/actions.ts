import type { State } from '../state'

// What the undo stack did, for the flush's entries (Part 1 §1.3.8, §1.6.4 step 1). A
// dependency-free registry, as resetHooks is, so the storage modules can listen without the
// history module importing them. Step 3b's entry hooks build on it.

export type HistoryAction =
    | {
          kind: 'reset'
          state: State
          name: () => string
          isDirty: boolean
          /** A blank start or New, or a chart brought in (an import, a restored auto save). */
          origin: 'new' | 'import'
      }
    | { kind: 'edit'; state: State; name: () => string; isDirty: boolean }
    /** The state landed on, and the name of the step undone or redone. */
    | { kind: 'undo' | 'redo'; state: State; name: () => string; isDirty: boolean }

const listeners = new Set<(action: HistoryAction) => void>()

/** Listens to every change of the undo stack; returns the removal. */
export const onHistoryAction = (listener: (action: HistoryAction) => void) => {
    listeners.add(listener)
    return () => {
        listeners.delete(listener)
    }
}

export const emitHistoryAction = (action: HistoryAction) => {
    for (const listener of [...listeners]) listener(action)
}
