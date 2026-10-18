import { computed, shallowRef, watch, type Ref } from 'vue'
import type { State } from '../state'
import { liveState, peek, isPeeking as peeking, pushState, stackGeneration } from './stack'

// Peek (Part 1 §1.4.11): a History entry's state shown read-only in place of the current one,
// and Restore (§1.4.10.5). Writers read `liveState`, so nothing peeked reaches storage or files.
// Storage gives entries' states through `setPeekSource`; the editor adds its notices and the
// Elevation Editor's reopening through `setPeekEffects` and `onPeekLeft`.

/** A timeline entry: its session and `seq`, as `<sessionId>:<seq>` (§1.3.7, §1.6.11.2). */
export type EntryKey = `${string}:${number}`

export const entryKey = (sessionId: string, seq: number): EntryKey => `${sessionId}:${seq}`

export const parseEntryKey = (key: EntryKey) => {
    const at = key.lastIndexOf(':')
    return { sessionId: key.slice(0, at), seq: Number(key.slice(at + 1)) }
}

/**
 * Why an entry can't be peeked: no such entry (yet) in storage, its snapshot removed to save
 * space, or a part of it missing or failing its hash (`history.damaged`).
 */
export type PeekFailure = 'missing' | 'removed' | 'damaged'

export class PeekError extends Error {
    override name = 'PeekError'
    constructor(readonly reason: PeekFailure) {
        super(`The entry cannot be shown: ${reason}`)
    }
}

/** An entry's state and when it was made. */
export type PeekedEntry = { state: State; time: number }

export type PeekSource = {
    /**
     * The entry's state: from memory when held, else built from its stored snapshot, verified.
     * Rejects when it can't be read (removed, damaged, unknown).
     */
    load: (key: EntryKey) => Promise<PeekedEntry>
    /** Whether two states have the same snapshot: Restore then changes nothing. */
    sameSnapshot: (a: State, b: State) => boolean
}

export type PeekEffects = {
    /** The stored label of a Restore's entry, "Restored to 2:40:31 PM". */
    restoredLabel: (time: number) => () => string
    /** After a Restore: "Restored to 2:40:31 PM". */
    restored: (time: number) => void
    /** A Restore that would change nothing: "Already matches the current chart". */
    alreadyMatches: () => void
}

let source: PeekSource | undefined
let effects: PeekEffects | undefined

/** Set once storing has started: entries can be peeked from then on. */
export const setPeekSource = (next: PeekSource | undefined) => {
    source = next
    cache.clear()
    loading.clear()
}

export const setPeekEffects = (next: PeekEffects | undefined) => {
    effects = next
}

/** Whether a History entry is shown in place of the current state: set from the request on. */
export const isPeeking: Readonly<Ref<boolean>> = peeking

const requested = shallowRef<EntryKey>()

/** The entry last asked for, shown or still loading; undefined when not peeking. */
export const peekedKey: Readonly<Ref<EntryKey | undefined>> = computed(() => requested.value)

/** True once a peek has waited about 150 ms for its state: the peek bar's spinner. */
export const peekLoading: Readonly<Ref<boolean>> = computed(() => spinning.value)

const spinning = shallowRef(false)

/** Requests closer together than this wait for the last (arrowing, §1.4.11). */
export const PEEK_DEBOUNCE_MS = 100
const SPINNER_AFTER_MS = 150
/** States kept for peeking, most recently used last (§1.4.11's LRU). */
export const PEEK_LRU = 8

const cache = new Map<EntryKey, PeekedEntry>()

const remember = (key: EntryKey, entry: PeekedEntry) => {
    cache.delete(key)
    cache.set(key, entry)
    for (const old of cache.keys()) {
        if (cache.size <= PEEK_LRU) break
        cache.delete(old)
    }
}

/** Loads in flight, so Restore during a peek's load reads the entry once. */
const loading = new Map<EntryKey, Promise<PeekedEntry>>()

const loadEntry = async (key: EntryKey) => {
    const held = cache.get(key)
    if (held) {
        remember(key, held)
        return held
    }
    if (!source) throw new PeekError('missing')
    const inFlight = loading.get(key)
    if (inFlight) return inFlight
    const from = source
    const load = from.load(key).finally(() => {
        if (loading.get(key) === load) loading.delete(key)
    })
    loading.set(key, load)
    const entry = await load
    // A source replaced meanwhile holds other states.
    if (source === from) remember(key, entry)
    return entry
}

/** An entry's state as peek loads it, through the same LRU and loads in flight: the change view's. */
export const loadEntryState = async (key: EntryKey) => (await loadEntry(key)).state

/**
 * What a peek shows: no selection at first, since the peeked state holds its own, and the live
 * audio and its waveform, which playback keeps while peeking (§1.4.11).
 */
const shown = (state: State): State => {
    const { buffer, waveform } = liveState.value.bgm
    return {
        ...state,
        bgm: { ...state.bgm, buffer, waveform },
        selectedEntities: [],
    }
}

/** Counts requests and leaves, so a load that finishes after either does nothing. */
let generation = 0
let lastRequestAt = -Infinity
let timer: ReturnType<typeof setTimeout> | undefined
let spinnerTimer: ReturnType<typeof setTimeout> | undefined
/** Resolves the request a later one replaced. */
let settlePrevious: (() => void) | undefined

const stopTimers = () => {
    clearTimeout(timer)
    timer = undefined
    clearTimeout(spinnerTimer)
    spinnerTimer = undefined
    spinning.value = false
}

/**
 * Shows an entry's state, read-only. Peeking starts at once, over what's shown, so nothing can
 * edit while the state loads; a later call replaces this one, which then resolves. Rejects, and
 * leaves the peek, when the entry can't be read.
 */
export const peekEntry = (key: EntryKey): Promise<void> => {
    const at = ++generation
    settlePrevious?.()
    settlePrevious = undefined
    requested.value = key
    if (!peek.value) {
        // Drags and sessions end on the live state, before anything is peeked.
        for (const listener of [...startListeners]) listener()
        peek.value = { source: key, state: shown(liveState.value) }
    }

    const now = Date.now()
    const quick = now - lastRequestAt < PEEK_DEBOUNCE_MS
    lastRequestAt = now
    clearTimeout(timer)
    timer = undefined
    spinnerTimer ??= setTimeout(() => {
        if (requested.value) spinning.value = true
    }, SPINNER_AFTER_MS)

    return new Promise<void>((resolve, reject) => {
        settlePrevious = resolve
        const run = async () => {
            timer = undefined
            let entry: PeekedEntry
            try {
                entry = await loadEntry(key)
            } catch (error) {
                if (at !== generation) {
                    resolve()
                    return
                }
                settlePrevious = undefined
                leavePeek()
                reject(error instanceof Error ? error : new Error(String(error)))
                return
            }
            if (at !== generation || !peek.value) {
                resolve()
                return
            }
            settlePrevious = undefined
            stopTimers()
            peek.value = { source: key, state: shown(entry.state) }
            resolve()
        }
        if (quick) timer = setTimeout(() => void run(), PEEK_DEBOUNCE_MS)
        else void run()
    })
}

const startListeners = new Set<() => void>()

/** Runs as a peek starts, before the peeked state is shown: drags and sessions end. */
export const onPeekStart = (listener: () => void) => {
    startListeners.add(listener)
    return () => {
        startListeners.delete(listener)
    }
}

const leftListeners = new Set<() => void>()

/** Runs after the user leaves a peek (Back to Now, Esc, closing History, Restore, Undo…). */
export const onPeekLeft = (listener: () => void) => {
    leftListeners.add(listener)
    return () => {
        leftListeners.delete(listener)
    }
}

/** Goes back to now: the peeked state and its selection are discarded. */
export const leavePeek = () => {
    generation++
    stopTimers()
    settlePrevious?.()
    settlePrevious = undefined
    requested.value = undefined
    if (!peek.value) return
    peek.value = undefined
    for (const listener of [...leftListeners]) listener()
}

// A reset or a stored stack replacing the history ends any peek (§1.3.8).
watch(
    peek,
    (value) => {
        if (value || !requested.value) return
        generation++
        stopTimers()
        settlePrevious?.()
        settlePrevious = undefined
        requested.value = undefined
    },
    { flush: 'sync' },
)

/**
 * Restores an entry (§1.4.10.5): the snapshot's chart, offset and level info with the current
 * audio, pushed as an undoable `restore` entry. Leaves any peek first. When it already matches
 * the current chart, nothing is pushed.
 */
export const restoreEntry = async (key: EntryKey): Promise<void> => {
    const stack = stackGeneration()
    const entry = await loadEntry(key)
    // A New or an open meanwhile replaced the session it belongs to.
    if (stackGeneration() !== stack) return
    leavePeek()
    const live = liveState.value
    const restored: State = {
        ...entry.state,
        bgm: { ...live.bgm, offset: entry.state.bgm.offset },
        selectedEntities: [],
    }
    if (source?.sameSnapshot(restored, live)) {
        effects?.alreadyMatches()
        return
    }
    pushState(effects?.restoredLabel(entry.time) ?? (() => ''), restored, 'restore')
    effects?.restored(entry.time)
}

/** What a refusal names: the command's title when a command was refused. */
export type PeekRefusal = { title?: () => string }

const refusedListeners = new Set<(refusal: PeekRefusal) => void>()

/** Runs when a command or tool is refused while peeking, after its notice. */
export const onPeekRefused = (listener: (refusal: PeekRefusal) => void) => {
    refusedListeners.add(listener)
    return () => {
        refusedListeners.delete(listener)
    }
}

/** Says why something didn't run while peeking: "Read-only while viewing history". */
export const refuseWhilePeeking = (refusal: PeekRefusal = {}) => {
    for (const listener of [...refusedListeners]) listener(refusal)
}

/** Drops cached states and any peek, for tests. */
export const resetPeekForTests = () => {
    leavePeek()
    cache.clear()
    loading.clear()
    lastRequestAt = -Infinity
}
