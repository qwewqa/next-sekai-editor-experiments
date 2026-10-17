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

/**
 * Actions since the last reset, kept until storing starts after first paint, so edits made before
 * then are stored too. Dropped once a listener takes them, so it never holds dropped redo states.
 */
let early: HistoryAction[] | undefined = []

/** The most early actions kept: the last reset and the newest after it, if storing never starts. */
export const EARLY_LIMIT = 256

/** Listens to every change of the undo stack; `replay` first delivers those since the last reset. */
export const onHistoryAction = (
    listener: (action: HistoryAction) => void,
    { replay = false }: { replay?: boolean } = {},
) => {
    if (replay) {
        const actions = early ?? []
        early = undefined
        for (const action of actions) listener(action)
    }
    listeners.add(listener)
    return () => {
        listeners.delete(listener)
    }
}

export const emitHistoryAction = (action: HistoryAction) => {
    if (early) {
        if (action.kind === 'reset') early = []
        early.push(action)
        // A start that never comes (a failed import) mustn't hold every state for the page's life.
        if (early.length > EARLY_LIMIT) early.splice(1, 1)
    }
    for (const listener of [...listeners]) listener(action)
}
