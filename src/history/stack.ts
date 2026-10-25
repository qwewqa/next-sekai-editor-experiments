import { computed, ref, shallowReactive, shallowRef, watch, type Ref } from 'vue'
import { recordError } from '../diagnostics'
import type { State } from '../state'
import { emitHistoryAction } from './actions'
import { cappedSpan, STACK_CAP } from './cap'
import { freezePublished } from './freeze'
import {
    captureOperation,
    captureStep,
    type NativeOperation,
    type UndoableStep,
} from './operations'
import { sameChart } from './sameChart'

export type HistoryEntry = {
    isDirty: boolean
    step: UndoableStep
    state: State
}

/**
 * A slot of the undo stack: a state, or for a slot restored from storage a
 * snapshot ref whose state is built when Undo or Redo reaches it. The slot at the
 * index is always loaded.
 */
type Slot = {
    isDirty: boolean
    step: UndoableStep
    state?: State
    /** The stored root, for a restored slot. */
    snapshot?: Uint8Array
}

const index = ref(0)

const states = shallowReactive<Slot[]>([])

/**
 * A state shown in place of the current one, read-only, while viewing history. With `audio:
 * 'none'` it plays without BGM (a session's peek); else playback keeps the live audio.
 */
export const peek = shallowRef<{ source: unknown; state: State; audio?: 'live' | 'none' }>()

export const isPeeking = computed(() => !!peek.value)

/** Undo (negative) or Redo steps pressed while their slot loads, coalesced. */
const pendingMove = ref(0)

export const canUndo = computed(() => index.value + pendingMove.value > 0)

export const canRedo = computed(() => index.value + pendingMove.value < states.length - 1)

/**
 * Whether steps before the stack's first slot are in History: the stack keeps at most
 * `STACK_CAP` slots, so Undo past them shows a notice.
 */
export const earlierSteps = ref(false)

/** Whether the stack holds only its first state: nothing done, nothing to redo. */
export const isPristine = computed(() => states.length <= 1)

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
const current = computed(() => states[index.value]!)

export const isDirty = computed(() => (current.value as Slot | undefined)?.isDirty ?? false)

/**
 * The current slot's stored root, when it has one: only a slot restored from storage (a pushed
 * slot has none, and a selection-only replacement keeps the restored one).
 */
export const headSnapshot = computed(() => (current.value as Slot | undefined)?.snapshot)

/**
 * The stored root of the current slot, only while that slot is loaded. While it is not,
 * `liveState` shows the previous head, so a root read beside it would pair with the wrong state.
 */
export const loadedHeadSnapshot = computed(() => {
    const slot = current.value as Slot | undefined
    return slot?.state ? slot.snapshot : undefined
})

/** The complete step that made the current state: the Timeline's Now row. */
export const headStep = computed(() => (current.value as Slot | undefined)?.step)

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
/** Restored slots kept loaded besides the head and its neighbours. */
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

/**
 * What became of the moves queued together while their slot loaded: they landed (the net
 * direction, and the last step crossed), or nothing changed because an edit or a peek cancelled
 * them or they netted to nothing, or the slot could not be read.
 */
export type MoveOutcome =
    | { kind: 'landed'; direction: -1 | 1; step: UndoableStep }
    | { kind: 'cancelled' }
    | { kind: 'failed'; direction: -1 | 1 }

/** The moves queued together: presses share one outcome, which settles once. */
let batch: { outcome: Promise<MoveOutcome>; end: (outcome: MoveOutcome) => void } | undefined
/** The outcome of the latest Undo or Redo request, when it was queued. */
let requested: Promise<MoveOutcome> | undefined

const endBatch = (outcome: MoveOutcome) => {
    const ended = batch
    batch = undefined
    if (ended && requested === ended.outcome) requested = undefined
    ended?.end(outcome)
}

/**
 * The outcome of the Undo or Redo just requested, when it was queued behind a slot's load; none
 * when it landed at once or was refused. The caller that must tell the user what happened waits
 * for it, so the notice is true when it shows (a queued move can still be cancelled or fail).
 */
export const pendingMoveOutcome = () => requested

/** Any edit, or entering peek, cancels pending moves. */
export const cancelPendingMoves = () => {
    if (!pendingMove.value && !batch) return
    pendingMove.value = 0
    generation++
    setBusy(false)
    endBatch({ kind: 'cancelled' })
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
    // A slot dropped from the stack while its read was out (a reset, an edit past it) is not kept.
    if (slot.snapshot && states.includes(slot)) evictRestored(slot)
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
                recordError(error)
                console.error('A stored undo step could not be loaded', error)
                return false
            },
        )
        reading.set(slot, read)
    }
    return read
}

/** Moves the index one step, as Undo or Redo does, emitting the entry. */
const step = (direction: -1 | 1): UndoableStep => {
    const crossed = direction < 0 ? current.value.step : states[index.value + 1]?.step
    index.value += direction
    const { state, snapshot, isDirty } = current.value
    // An intermediate slot of a coalesced move needn't load: its entry names its stored root.
    const landed = state ? { state } : snapshot ? { snapshot } : undefined
    if (!landed || !crossed) throw new Error('A move landed on a slot with no state')
    emitHistoryAction({ kind: direction < 0 ? 'undo' : 'redo', ...landed, step: crossed, isDirty })
    if (state && current.value.snapshot) evictRestored(current.value)
    return crossed
}

/** Prefetches the head's neighbours when idle. */
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
            if (at === generation) {
                // Nothing moved, and the user can try again: the next press reads the slot anew.
                endBatch({ kind: 'failed', direction: pendingMove.value < 0 ? -1 : 1 })
                cancelPendingMoves()
            }
            return
        }
        if (at !== generation) return
    }
    const moves = pendingMove.value
    pendingMove.value = 0
    setBusy(false)
    let last: UndoableStep | undefined
    for (let i = 0; i < Math.abs(moves); i++) last = step(moves < 0 ? -1 : 1)
    // Moves that net to nothing changed nothing.
    endBatch(
        last
            ? { kind: 'landed', direction: moves < 0 ? -1 : 1, step: last }
            : { kind: 'cancelled' },
    )
    prefetch()
}

/** Queues a move onto a slot not loaded; held keys add to it. Returns the complete crossed step. */
const queue = (direction: -1 | 1) => {
    const from = index.value + pendingMove.value
    const crossed = direction < 0 ? states[from]?.step : states[from + 1]?.step
    const first = pendingMove.value === 0
    pendingMove.value += direction
    if (!batch) {
        let end!: (outcome: MoveOutcome) => void
        const outcome = new Promise<MoveOutcome>((resolve) => {
            end = resolve
        })
        batch = { outcome, end }
    }
    requested = batch.outcome
    if (first) {
        setBusy(true)
        void settle()
    }
    return crossed
}

/** Whether two states hold the same chart and header: all but the selection is the same object. */
const sameParts = (a: State, b: State) =>
    a.store === b.store &&
    a.bpms === b.bpms &&
    a.groups === b.groups &&
    a.stages === b.stages &&
    a.groupFolders === b.groupFolders &&
    a.stageFolders === b.stageFolders &&
    a.levelInfo === b.levelInfo &&
    a.initialLife === b.initialLife &&
    a.isDynamicStages === b.isDynamicStages &&
    a.bgm.offset === b.bgm.offset &&
    a.bgm.meta === b.bgm.meta

/**
 * Replaces the current slot, or only the peeked state, which holds its own selection. For a
 * selection change only: the slot keeps its stored root just when the chart and header are the
 * state it had, so a caller that changed more can never leave a root naming another chart.
 */
const replaceCurrent = (state: State) => {
    if (peek.value) {
        peek.value = { ...peek.value, state }
        return
    }

    const old = current.value
    const slot: Slot = {
        isDirty: old.isDirty,
        step: old.step,
        state: publish(state),
        // A selection change keeps the slot's chart, so its stored root still holds.
        ...(old.snapshot && old.state && sameParts(old.state, state)
            ? { snapshot: old.snapshot }
            : {}),
    }
    // A restored slot keeps its place in the LRU, so it can still go back to its ref.
    const at = loadedRestored.indexOf(old)
    if (at !== -1) {
        if (slot.snapshot) loadedRestored[at] = slot
        else loadedRestored.splice(at, 1)
    }
    states[index.value] = slot
}

export const replaceState = replaceCurrent

/** Whether two selections hold the same entities in the same order. */
const sameSelection = (a: State, b: State) =>
    a === b ||
    (a.selectedEntities.length === b.selectedEntities.length &&
        a.selectedEntities.every((entity, i) => entity === b.selectedEntities[i]))

/**
 * Pushes a state: an edit, or Restore of a History entry, which leaves the peek first.
 * An edit that leaves the chart as it was is no step: the chart is compared
 * as its stored records, so it holds however the entities were rebuilt. A selection it changed
 * still takes effect, as every selection change does, without a step. Returns whether a step
 * was pushed, so a caller tells the user of an edit only when there was one.
 */
export const pushState = (
    operation: NativeOperation,
    state: State,
    kind: 'edit' | 'restore' = 'edit',
): boolean => {
    // Every edit path is gated while peeking, so one that is not fails in development and tests.
    if (peek.value) {
        if (isProduction()) return false
        throw new Error('pushState while viewing history')
    }
    // Callers built `state` from what's on screen: a queued move can never reorder it.
    const step = captureStep({ kind, operation })
    if (kind === 'edit' && sameChart(currentState.value, state)) {
        if (!sameSelection(currentState.value, state)) replaceCurrent(state)
        return false
    }
    cancelPendingMoves()

    const dropped = states.splice(index.value + 1, states.length - index.value - 1, {
        isDirty: true,
        step,
        state: publish(state),
    })
    // Past the cap the oldest slot is dropped; its step stays in the Timeline. The head is the
    // new slot, so it is never a dropped one.
    const over = Math.max(0, states.length - STACK_CAP)
    if (over) {
        dropped.push(...states.splice(0, over))
        earlierSteps.value = true
    }
    // The redo tail and the dropped slots are gone: their loaded states go with them, not held
    // until later loads push them out.
    for (const slot of dropped) {
        const at = loadedRestored.indexOf(slot)
        if (at !== -1) loadedRestored.splice(at, 1)
    }
    index.value += 1 - over
    emitHistoryAction({ kind, state, step, isDirty: true })
    return true
}

const moveRequestGeneration = shallowRef(0)
/** Counts accepted Undo/Redo requests, before any queued slot load. */
export const stackMoveRequestGeneration: Readonly<Ref<number>> = computed(
    () => moveRequestGeneration.value,
)

/**
 * Undoes a step: synchronously when the slot is loaded, as callers and tests expect; otherwise
 * the move is queued while the slot loads, and further presses coalesce.
 */
export const undoState = () => {
    requested = undefined
    if (!canUndo.value) return
    moveRequestGeneration.value++
    if (pendingMove.value || !states[index.value - 1]?.state) return queue(-1)

    const crossed = current.value.step
    step(-1)
    prefetch()
    return crossed
}

export const redoState = () => {
    requested = undefined
    if (!canRedo.value) return
    moveRequestGeneration.value++
    if (pendingMove.value || !states[index.value + 1]?.state) return queue(1)

    step(1)
    prefetch()
    return current.value.step
}

/** Records a file event without touching the stack: a `save` or `export` entry. */
export const markFileEvent = (
    kind: 'save' | 'export',
    operation: NativeOperation,
    isDirty = current.value.isDirty,
) => {
    emitHistoryAction({
        kind,
        state: currentState.value,
        operation: captureOperation(operation),
        isDirty,
    })
}

/** Counts the stacks replaced (a reset, a stored stack): what an entry's Restore is relative to. */
let stacks = 0

export const stackGeneration = () => stacks

/** Replaces the whole history with one entry, leaving any peek. */
export const resetStates = (entry: HistoryEntry, origin: 'new' | 'import' = 'new') => {
    entry = { ...entry, step: captureStep(entry.step) }
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
 * A slot of a stored stack: its root and complete step, and whether it was changed since the file event.
 * A slot given loaded with no root (a journal's head while storage is unavailable) stays loaded.
 */
export type RestoredSlot = { snapshot?: Uint8Array; step: UndoableStep; isDirty: boolean }

/**
 * Replaces the stack with a stored one, its slots lazy and the head given loaded (a
 * reload, a new visit, an open, Restore Session). A stack over the cap is cut to it around the
 * index. Nothing is emitted: the storage side starts the session itself, with the entry each of
 * those appends.
 */
export const restoreStates = (
    slots: readonly RestoredSlot[],
    at: number,
    head: State,
    earlier = false,
) => {
    if (!slots[at]) throw new RangeError('The index is outside the stack')
    const kept = cappedSpan(slots.length, at)
    const restored: Slot[] = slots
        .slice(kept.base, kept.base + kept.length)
        .map(({ snapshot, step, isDirty }) => ({
            isDirty,
            step: captureStep(step),
            ...(snapshot ? { snapshot: snapshot.slice() } : {}),
        }))
    const headAt = at - kept.base
    stacks++
    cancelPendingMoves()
    earlierSteps.value = earlier || kept.base > 0
    peek.value = undefined
    loadedRestored.length = 0
    // The head is loaded before anything can read it: watchers run as the stack changes.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    restored[headAt]!.state = publish(head)
    states.splice(0, states.length, ...restored)
    index.value = headAt
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    if (restored[headAt]!.snapshot) evictRestored(restored[headAt]!)
    prefetch()
}

/** The loaded slots' states, with their stored roots when restored: peek reuses them. */
export const loadedStates = () =>
    states.flatMap(({ state, snapshot }) => (state ? [{ state, snapshot }] : []))

/** Which slots hold a state, for tests of the lazy stack. */
export const loadedSlotsForTests = () => states.map((slot) => !!slot.state)

/** How many restored slots the LRU holds, for tests of the lazy stack. */
export const restoredLoadedForTests = () => loadedRestored.length

/** How many steps the undo stack holds, for the usage statistics’ chart size. */
export const stackLength = () => states.length
