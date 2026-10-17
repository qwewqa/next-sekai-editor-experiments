import type { State } from '../state'

// What the undo stack did, for the flush's entries (Part 1 §1.3.8, §1.6.4 step 1). A
// dependency-free registry, as resetHooks is, so the storage modules can listen without the
// history module importing them: the entry hooks.

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
    /**
     * The state landed on, and the name of the step undone or redone. A coalesced move's
     * intermediate steps land on slots not loaded: their stored root stands for the state.
     */
    | ({ kind: 'undo' | 'redo'; name: () => string; isDirty: boolean } & (
          { state: State; snapshot?: undefined } | { state?: undefined; snapshot: Uint8Array }
      ))
    /** A file event: the stack is unchanged (Part 1 §1.3.8). */
    | { kind: 'save' | 'export'; state: State; name: () => string; isDirty: boolean }

const listeners = new Set<(action: HistoryAction) => void>()

/**
 * Actions since the last reset, kept until storing starts after first paint, so edits made before
 * then are stored too. Dropped once a listener takes them, so it never holds dropped redo states.
 */
let early: HistoryAction[] | undefined = []

/** A slot of the stack the early actions give. */
type EarlySlot = { state: State; name: () => string; isDirty: boolean }

/** The undo stack the early actions give, so they can be cut down to it. */
type EarlyStack = { origin: 'new' | 'import'; slots: EarlySlot[]; index: number }

let stack: EarlyStack | undefined

/**
 * Early actions past this many beyond the stack's own are cut down to the actions that give the
 * stack as it is: its pushes, then its undos. Their replay is still the stack, so storing can
 * follow the actions after them; only states a redo branch dropped go (§1.6.4 #6).
 */
export const EARLY_LIMIT = 256

/** Follows an action on the early stack; undefined when it can't. */
const follow = (at: EarlyStack | undefined, action: HistoryAction): EarlyStack | undefined => {
    if (!at) return
    switch (action.kind) {
        case 'edit':
            at.slots.length = at.index + 1
            at.slots.push({ state: action.state, name: action.name, isDirty: action.isDirty })
            at.index++
            return at
        case 'undo':
        case 'redo':
            at.index += action.kind === 'undo' ? -1 : 1
            return at.index >= 0 && at.index < at.slots.length ? at : undefined
        case 'save':
        case 'export':
        case 'reset':
            return at
    }
}

/** The actions that give the early stack: a reset, a push per slot, then undos to its index. */
const actionsOf = ({ origin, slots, index }: EarlyStack): HistoryAction[] => {
    const actions: HistoryAction[] = slots.map((slot, i) =>
        i === 0 ? { kind: 'reset', ...slot, origin } : { kind: 'edit', ...slot },
    )
    for (let at = slots.length - 1; at > index; at--) {
        const [landed, undone] = [slots[at - 1], slots[at]]
        if (landed && undone) actions.push({ kind: 'undo', ...landed, name: undone.name })
    }
    return actions
}

/** Listens to every change of the undo stack; `replay` first delivers those since the last reset. */
export const onHistoryAction = (
    listener: (action: HistoryAction) => void,
    { replay = false }: { replay?: boolean } = {},
) => {
    if (replay) {
        const actions = early ?? []
        early = undefined
        stack = undefined
        for (const action of actions) listener(action)
    }
    listeners.add(listener)
    return () => {
        listeners.delete(listener)
    }
}

export const emitHistoryAction = (action: HistoryAction) => {
    if (early) {
        if (action.kind === 'reset') {
            early = [action]
            stack = {
                origin: action.origin,
                slots: [{ state: action.state, name: action.name, isDirty: action.isDirty }],
                index: 0,
            }
        } else {
            early.push(action)
            stack = follow(stack, action)
        }
        // A start that never comes (a failed import) mustn't hold every state for the page's life.
        if (early.length > EARLY_LIMIT + (stack?.slots.length ?? 0)) {
            // Without a stack to cut to, the newest is let go, never one in the middle.
            if (stack) early = actionsOf(stack)
            else early.pop()
        }
    }
    for (const listener of [...listeners]) listener(action)
}
