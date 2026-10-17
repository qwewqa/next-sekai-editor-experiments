import { computed, ref, shallowReactive, shallowRef } from 'vue'
import type { State } from '../state'
import { emitHistoryAction } from './actions'
import { freezePublished } from './freeze'

export type HistoryEntry = {
    isDirty: boolean
    name: () => string
    state: State
}

const index = ref(0)

const states = shallowReactive<HistoryEntry[]>([])

/** A state shown in place of the current one, read-only, while viewing history. */
export const peek = shallowRef<{ source: unknown; state: State }>()

export const isPeeking = computed(() => !!peek.value)

export const canUndo = computed(() => index.value > 0)

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
const current = computed(() => states[index.value]!)

export const isDirty = computed(() => current.value.isDirty)

/** The displayed state, which is the peeked one while viewing history. */
export const state = computed(() => peek.value?.state ?? current.value.state)

/** The current state, which writers and exporters read, never a peeked one. */
export const liveState = computed(() => current.value.state)

// Vite sets it; Node tests have no import.meta.env.
const isProduction = () => (import.meta as { env?: { PROD?: boolean } }).env?.PROD === true

/** A state the stack publishes is frozen outside release builds, so no one changes it in place. */
const publish = (state: State) => {
    if (!isProduction()) freezePublished(state)
    return state
}

/** Replaces the current slot, or only the peeked state, which holds its own selection. */
export const replaceState = (state: State) => {
    if (peek.value) {
        peek.value = { ...peek.value, state }
        return
    }

    states[index.value] = {
        isDirty: current.value.isDirty,
        name: current.value.name,
        state: publish(state),
    }
}

export const pushState = (name: () => string, state: State) => {
    // Every edit path is gated while peeking, so one that is not fails in development and tests.
    if (peek.value) {
        if (isProduction()) return
        throw new Error('pushState while viewing history')
    }

    states.splice(index.value + 1, states.length - index.value - 1, {
        isDirty: true,
        name,
        state: publish(state),
    })
    index.value++
    emitHistoryAction({ kind: 'edit', state, name, isDirty: true })
}

export const undoState = () => {
    if (!canUndo.value) return

    const name = current.value.name
    index.value--
    const { state, isDirty } = current.value
    emitHistoryAction({ kind: 'undo', state, name, isDirty })
    return name
}

export const redoState = () => {
    if (index.value >= states.length - 1) return

    index.value++
    const { state, name, isDirty } = current.value
    emitHistoryAction({ kind: 'redo', state, name, isDirty })
    return name
}

/** Replaces the whole history with one entry, leaving any peek. */
export const resetStates = (entry: HistoryEntry, origin: 'new' | 'import' = 'new') => {
    peek.value = undefined
    index.value = 0
    publish(entry.state)
    states.splice(0, states.length, entry)
    emitHistoryAction({ kind: 'reset', ...entry, origin })
}
