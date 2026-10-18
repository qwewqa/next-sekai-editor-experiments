import { computed, ref, shallowReactive, shallowRef, watch } from 'vue'
import type { State } from '../state'
import { emitHistoryAction } from './actions'
import { freezePublished } from './freeze'

export type HistoryEntry = {
    isDirty: boolean
    name: () => string
    state: State
}

/**
 * A slot of the undo stack (Part 1 §1.3.7): a state, or for a slot restored from storage a
 * snapshot ref whose state is built when Undo or Redo reaches it (§1.6.4 #6). The slot at the
 * index is always loaded.
 */
type Slot = {
    isDirty: boolean
    name: () => string
    state?: State
    /** The stored root, for a restored slot. */
    snapshot?: Uint8Array
}

const index = ref(0)

const states = shallowReactive<Slot[]>([])

/** A state shown in place of the current one, read-only, while viewing history. */
export const peek = shallowRef<{ source: unknown; state: State }>()

export const isPeeking = computed(() => !!peek.value)

/** Undo (negative) or Redo steps pressed while their slot loads, coalesced (§1.6.4 #6). */
const pendingMove = ref(0)

export const canUndo = computed(() => index.value + pendingMove.value > 0)

/**
 * Whether steps before the stack's first slot are in History: a stored stack is capped
 * (§1.6.4 #6), so Undo past it after a reload says so.
 */
export const earlierSteps = ref(false)

/** Whether the stack holds only its first state: nothing done, nothing to redo. */
export const isPristine = computed(() => states.length <= 1)

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
const current = computed(() => states[index.value]!)

export const isDirty = computed(() => (current.value as Slot | undefined)?.isDirty ?? false)

/** The name of the step that made the current state: the Timeline's Now row. */
export const headName = computed(() => (current.value as Slot | undefined)?.name() ?? '')

/** The last head seen: what watchers read while a stored stack replaces the slots. */
let lastHead: State | undefined

/**
 * The head is always loaded. While `restoreStates` swaps the slots and the index in turn, a
 * synchronous watcher may look in between; it sees the previous head until the index follows.
 */
const currentState = computed(() => {
    const head = (current.value as Slot | undefined)?.state ?? lastHead
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    lastHead = head!
    return lastHead
})

/** The displayed state, which is the peeked one while viewing history. */
export const state = computed(() => peek.value?.state ?? currentState.value)

/** The current state, which writers and exporters read, never a peeked one. */
export const liveState = computed(() => currentState.value)

// Vite sets it; Node tests have no import.meta.env.
const isProduction = () => (import.meta as { env?: { PROD?: boolean } }).env?.PROD === true

/** A state the stack publishes is frozen outside release builds, so no one changes it in place. */
const publish = (state: State) => {
    if (!isProduction()) freezePublished(state)
    return state
}

/** Builds a restored slot's state from its snapshot; set once storing has started. */
let loader: ((snapshot: Uint8Array) => Promise<State>) | undefined

export const setSlotLoader = (load: typeof loader) => {
    loader = load
}

/** True while a queued move has waited about 150 ms for its slot: the busy cursor. */
export const slotLoading = shallowRef(false)

const BUSY_AFTER_MS = 150
/** Restored slots kept loaded besides the head and its neighbours (§1.6.4 #5). */
const RESTORED_LRU = 8

/** Counts cancellations, so a load that finishes after one does nothing. */
let generation = 0
let busyTimer: ReturnType<typeof setTimeout> | undefined
/** Restored slots loaded, least recently used first. */
const loadedRestored: Slot[] = []

const setBusy = (busy: boolean) => {
    clearTimeout(busyTimer)
    busyTimer = undefined
    if (busy) busyTimer = setTimeout(() => (slotLoading.value = true), BUSY_AFTER_MS)
    else slotLoading.value = false
}

/** Any edit, or entering peek, cancels pending moves (§1.6.4 #6). */
export const cancelPendingMoves = () => {
    if (!pendingMove.value) return
    pendingMove.value = 0
    generation++
    setBusy(false)
}

watch(
    peek,
    (value) => {
        if (value) cancelPendingMoves()
    },
    { flush: 'sync' },
)

/** Keeps restored slots outside the head and its neighbours to the LRU's size. */
const evictRestored = (slot: Slot) => {
    const at = loadedRestored.indexOf(slot)
    if (at !== -1) loadedRestored.splice(at, 1)
    loadedRestored.push(slot)
    const near = new Set([states[index.value - 1], states[index.value], states[index.value + 1]])
    let excess = loadedRestored.length - RESTORED_LRU
    for (let i = 0; i < loadedRestored.length && excess > 0; i++) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const old = loadedRestored[i]!
        if (near.has(old)) continue
        old.state = undefined
        loadedRestored.splice(i--, 1)
        excess--
    }
}

const loaded = (slot: Slot, state: State) => {
    slot.state = publish(state)
    if (slot.snapshot) evictRestored(slot)
}

/** Reads in flight, so a prefetch and a queued move read a slot once. */
const reading = new WeakMap<Slot, Promise<boolean>>()

/** Loads a slot's state; resolves false when it can't (no loader, a failed read). */
const load = (slot: Slot): Promise<boolean> => {
    if (slot.state) return Promise.resolve(true)
    const { snapshot } = slot
    if (!snapshot || !loader) return Promise.resolve(false)
    let read = reading.get(slot)
    if (!read) {
        read = loader(snapshot).then(
            (state) => {
                reading.delete(slot)
                if (!slot.state) loaded(slot, state)
                return true
            },
            (error: unknown) => {
                reading.delete(slot)
                console.error('A stored undo step could not be loaded', error)
                return false
            },
        )
        reading.set(slot, read)
    }
    return read
}

/** Moves the index one step, as Undo or Redo does, emitting the entry. */
const step = (direction: -1 | 1) => {
    const name = direction < 0 ? current.value.name : states[index.value + 1]?.name
    index.value += direction
    const { state, snapshot, isDirty } = current.value
    // An intermediate slot of a coalesced move needn't load: its entry names its stored root.
    const landed = state ? { state } : snapshot ? { snapshot } : undefined
    if (!landed || !name) throw new Error('A move landed on a slot with no state')
    emitHistoryAction({ kind: direction < 0 ? 'undo' : 'redo', ...landed, name, isDirty })
    if (state && current.value.snapshot) evictRestored(current.value)
}

/** Prefetches the head's neighbours when idle (§1.6.4 #6). */
const prefetch = () => {
    const at = generation
    const run = () => {
        if (at !== generation) return
        for (const slot of [states[index.value - 1], states[index.value + 1]])
            if (slot && !slot.state) void load(slot)
    }
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run)
    else setTimeout(run, 0)
}

/** Applies the pending moves once their target is loaded, loading it first. */
const settle = async () => {
    const at = generation
    for (;;) {
        const target = states[index.value + pendingMove.value]
        if (!target) {
            cancelPendingMoves()
            return
        }
        if (target.state) break
        if (!(await load(target))) {
            if (at === generation) cancelPendingMoves()
            return
        }
        if (at !== generation) return
    }
    const moves = pendingMove.value
    pendingMove.value = 0
    setBusy(false)
    for (let i = 0; i < Math.abs(moves); i++) step(moves < 0 ? -1 : 1)
    prefetch()
}

/** Queues a move onto a slot not loaded; held keys add to it. Returns the step's name. */
const queue = (direction: -1 | 1) => {
    const from = index.value + pendingMove.value
    const name = direction < 0 ? states[from]?.name : states[from + 1]?.name
    const first = pendingMove.value === 0
    pendingMove.value += direction
    if (first) {
        setBusy(true)
        void settle()
    }
    return name
}

/** Replaces the current slot, or only the peeked state, which holds its own selection. */
export const replaceState = (state: State) => {
    if (peek.value) {
        peek.value = { ...peek.value, state }
        return
    }

    const old = current.value
    const slot: Slot = {
        isDirty: old.isDirty,
        name: old.name,
        state: publish(state),
        // A selection change keeps the slot's chart, so its stored root still holds.
        ...(old.snapshot ? { snapshot: old.snapshot } : {}),
    }
    // A restored slot keeps its place in the LRU, so it can still go back to its ref.
    const at = loadedRestored.indexOf(old)
    if (at !== -1) loadedRestored[at] = slot
    states[index.value] = slot
}

/** Pushes a state: an edit, or Restore of a History entry (§1.4.10.5), which leaves the peek first. */
export const pushState = (name: () => string, state: State, kind: 'edit' | 'restore' = 'edit') => {
    // Every edit path is gated while peeking, so one that is not fails in development and tests.
    if (peek.value) {
        if (isProduction()) return
        throw new Error('pushState while viewing history')
    }
    // Callers built `state` from what's on screen: a queued move can never reorder it.
    cancelPendingMoves()

    states.splice(index.value + 1, states.length - index.value - 1, {
        isDirty: true,
        name,
        state: publish(state),
    })
    index.value++
    emitHistoryAction({ kind, state, name, isDirty: true })
}

/**
 * Undoes a step: synchronously when the slot is loaded, as callers and tests expect; otherwise
 * the move is queued while the slot loads, and further presses coalesce (§1.6.4 #6).
 */
export const undoState = () => {
    if (!canUndo.value) return
    if (pendingMove.value || !states[index.value - 1]?.state) return queue(-1)

    const name = current.value.name
    step(-1)
    prefetch()
    return name
}

export const redoState = () => {
    if (index.value + pendingMove.value >= states.length - 1) return
    if (pendingMove.value || !states[index.value + 1]?.state) return queue(1)

    step(1)
    prefetch()
    return current.value.name
}

/** Records a file event without touching the stack: a `save` or `export` entry (§1.3.8). */
export const markFileEvent = (
    kind: 'save' | 'export',
    name: () => string,
    isDirty = current.value.isDirty,
) => {
    emitHistoryAction({ kind, state: currentState.value, name, isDirty })
}

/** Counts the stacks replaced (a reset, a stored stack): what an entry's Restore is relative to. */
let stacks = 0

export const stackGeneration = () => stacks

/** Replaces the whole history with one entry, leaving any peek. */
export const resetStates = (entry: HistoryEntry, origin: 'new' | 'import' = 'new') => {
    stacks++
    cancelPendingMoves()
    earlierSteps.value = false
    peek.value = undefined
    index.value = 0
    publish(entry.state)
    loadedRestored.length = 0
    states.splice(0, states.length, entry)
    emitHistoryAction({ kind: 'reset', ...entry, origin })
}

/**
 * A slot of a stored stack: its root and label, and whether it was changed since the file event.
 * A slot given loaded with no root (a journal's head while storage is unavailable) stays loaded.
 */
export type RestoredSlot = { snapshot?: Uint8Array; label: string; isDirty: boolean }

/**
 * Replaces the stack with a stored one, its slots lazy and the head given loaded (§1.3.8: a
 * reload, a new visit, an open, Restore Session). Nothing is emitted: the storage side starts
 * the session itself, with the entry each of those appends.
 */
export const restoreStates = (
    slots: readonly RestoredSlot[],
    at: number,
    head: State,
    earlier = false,
) => {
    const slot = slots[at]
    if (!slot) throw new RangeError('The index is outside the stack')
    stacks++
    cancelPendingMoves()
    earlierSteps.value = earlier
    peek.value = undefined
    loadedRestored.length = 0
    const restored: Slot[] = slots.map(({ snapshot, label, isDirty }) => ({
        isDirty,
        name: () => label,
        ...(snapshot ? { snapshot: snapshot.slice() } : {}),
    }))
    // The head is loaded before anything can read it: watchers run as the stack changes.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    restored[at]!.state = publish(head)
    states.splice(0, states.length, ...restored)
    index.value = at
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    if (restored[at]!.snapshot) evictRestored(restored[at]!)
    prefetch()
}

/** The loaded slots' states, with their stored roots when restored: peek reuses them. */
export const loadedStates = () =>
    states.flatMap(({ state, snapshot }) => (state ? [{ state, snapshot }] : []))

/** Which slots hold a state, for tests of the lazy stack. */
export const loadedSlotsForTests = () => states.map((slot) => !!slot.state)
