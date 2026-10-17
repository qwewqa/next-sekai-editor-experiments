import { computed, ref, shallowReactive, shallowRef } from 'vue'
import type { State } from '../state'

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

/** Replaces the current slot, or only the peeked state, which holds its own selection. */
export const replaceState = (state: State) => {
    if (peek.value) {
        peek.value = { ...peek.value, state }
        return
    }

    states[index.value] = {
        isDirty: current.value.isDirty,
        name: current.value.name,
        state,
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
        state,
    })
    index.value++
}

export const undoState = () => {
    if (!canUndo.value) return

    const name = current.value.name
    index.value--
    return name
}

export const redoState = () => {
    if (index.value >= states.length - 1) return

    index.value++
    return current.value.name
}

/** Replaces the whole history with one entry, leaving any peek. */
export const resetStates = (entry: HistoryEntry) => {
    peek.value = undefined
    index.value = 0
    states.splice(0, states.length, entry)
}
