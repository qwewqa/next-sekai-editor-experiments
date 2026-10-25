import { computed, shallowRef, watch, type Ref } from 'vue'
import { bump, busy, peekShown } from '../analytics/tally'
import type { State } from '../state'
import { sameFileContent } from '../state/fileContent'
import { onHistoryAction } from './actions'
import type { NativeOperation } from './operations'
import {
    liveState,
    peek,
    isPeeking as peeking,
    pushState,
    stackGeneration,
    stackMoveRequestGeneration,
} from './stack'

// Peek: a History entry's state shown read-only in place of the current one,
// and Restore. Writers read `liveState`, so nothing peeked reaches storage or files.
// Storage gives entries' states through `setPeekSource`; the editor adds its notices and the
// Elevation Editor's reopening through `setPeekEffects` and `onPeekLeft`.

/** A timeline entry: its session and `seq`, as `<sessionId>:<seq>`. */
export type EntryKey = `${string}:${number}`

export const entryKey = (sessionId: string, seq: number): EntryKey => `${sessionId}:${seq}`

export const parseEntryKey = (key: EntryKey) => {
    const at = key.lastIndexOf(':')
    return { sessionId: key.slice(0, at), seq: Number(key.slice(at + 1)) }
}

/**
 * Why an entry can't be peeked: no such entry (yet) in storage, its snapshot removed to save
 * space, a part of it missing or failing its hash (`history.damaged`), or its root written by a
 * newer version (`history.needsNewer`, never damage).
 */
export type PeekFailure = 'missing' | 'removed' | 'damaged' | 'newer'

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
    /** Captures a Restore operation before changing the live stack. */
    restoredOperation: (time: number) => NativeOperation
    /** After a Restore: "Restored to 2:40:31 PM". */
    restored: (time: number) => void
    /** A Restore that would change nothing: "Already matches the current chart". */
    alreadyMatches: () => void
}

let source: PeekSource | undefined
let effects: PeekEffects | undefined
const sourceGeneration = shallowRef(0)
export const peekSourceGeneration: Readonly<Ref<number>> = computed(() => sourceGeneration.value)

/** Set once storing has started: entries can be peeked from then on. */
export const setPeekSource = (next: PeekSource | undefined) => {
    leavePeek()
    source = next
    cache.clear()
    loading.clear()
    sourceGeneration.value++
}

export const setPeekEffects = (next: PeekEffects | undefined) => {
    effects = next
}

// Re-read hooks after synchronous stack listeners have run.
const notifyRestored = (time: number) => {
    effects?.restored(time)
}

/** Whether a History entry is shown in place of the current state: set from the request on. */
export const isPeeking: Readonly<Ref<boolean>> = peeking

const requested = shallowRef<EntryKey>()
const displayed = shallowRef<EntryKey>()

/** The entry last asked for, shown or still loading; undefined when not peeking. */
export const peekedKey: Readonly<Ref<EntryKey | undefined>> = computed(() => requested.value)

/** The loaded endpoint actually shown; the initial live placeholder is not ready. */
export const displayedPeekKey: Readonly<Ref<EntryKey | undefined>> = computed(() => displayed.value)

/** True once a peek has waited about 150 ms for its state: the peek bar's spinner. */
export const peekLoading: Readonly<Ref<boolean>> = computed(() => spinning.value)

const spinning = shallowRef(false)

/** Requests closer together than this wait for the last (arrowing). */
export const PEEK_DEBOUNCE_MS = 100
const SPINNER_AFTER_MS = 150
/** States kept for peeking, most recently used last (an LRU). */
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
    const fromGeneration = sourceGeneration.value
    const load = from.load(key).finally(() => {
        if (loading.get(key) === load) loading.delete(key)
    })
    loading.set(key, load)
    const entry = await load
    // A source replaced meanwhile holds other states.
    if (sourceGeneration.value === fromGeneration) remember(key, entry)
    return entry
}

/** An entry's state as peek loads it, through the same LRU and loads in flight: the change view's. */
export const loadEntryState = async (key: EntryKey) => (await loadEntry(key)).state

/**
 * The longest a peek waits for `ready`. When a change read takes longer, which only a large change
 * does, the step shows without its marks until the read lands, rather than the chart being held.
 */
export const PEEK_READY_MAX_MS = 100

/**
 * A session's peek (`audio: 'none'`) plays without BGM: the live audio is another session's.
 * `ready` is called with the loaded state before it shows; the state shows once its promise
 * settles or after `PEEK_READY_MAX_MS`, so the step's change can land with it.
 */
export type PeekOptions = {
    audio?: 'live' | 'none'
    ready?: (state: State) => Promise<unknown> | undefined
}

/** Waits for `ready`, at most `PEEK_READY_MAX_MS`; its failure only ends the wait. */
const waitReady = async (ready: Promise<unknown>) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        await Promise.race([
            ready.catch(() => undefined),
            new Promise<void>((done) => {
                timer = setTimeout(done, PEEK_READY_MAX_MS)
            }),
        ])
    } finally {
        clearTimeout(timer)
    }
}

/**
 * What a peek shows: no selection at first, since the peeked state holds its own, and the live
 * audio and its waveform, which playback keeps while peeking.
 */
const shown = (state: State, audio: PeekOptions['audio'] = 'live'): State => {
    if (audio === 'none') {
        const { buffer: _buffer, waveform: _waveform, ...bgm } = state.bgm
        return { ...state, bgm, selectedEntities: [] }
    }
    const { buffer, waveform } = liveState.value.bgm
    return {
        ...state,
        bgm: { ...state.bgm, buffer, waveform },
        selectedEntities: [],
    }
}

/** Counts requests and leaves, so a load that finishes after either does nothing. */
const generation = shallowRef(0)
export const peekRequestGeneration: Readonly<Ref<number>> = computed(() => generation.value)
let lastRequestAt = -Infinity
let timer: ReturnType<typeof setTimeout> | undefined
/** Runs the debounced request now; set while one waits. */
let pendingRun: (() => void) | undefined
let spinnerTimer: ReturnType<typeof setTimeout> | undefined
/** Resolves the request a later one replaced. */
let settlePrevious: (() => void) | undefined

const stopTimers = () => {
    clearTimeout(timer)
    timer = undefined
    pendingRun = undefined
    clearTimeout(spinnerTimer)
    spinnerTimer = undefined
    spinning.value = false
}

/**
 * Shows an entry's state, read-only. Peeking starts at once, over what's shown, so nothing can
 * edit while the state loads; a later call replaces this one, which then resolves. Rejects, and
 * leaves the peek, when the entry can't be read.
 */
export const peekEntry = (key: EntryKey, options: PeekOptions = {}): Promise<void> => {
    const at = ++generation.value
    settlePrevious?.()
    settlePrevious = undefined
    requested.value = key
    if (!peek.value) {
        displayed.value = undefined
        // Drags and sessions end on the live state, before anything is peeked.
        for (const listener of [...startListeners]) listener()
        peek.value = {
            source: key,
            state: shown(liveState.value, options.audio),
            audio: options.audio,
        }
    }

    const now = Date.now()
    const quick = now - lastRequestAt < PEEK_DEBOUNCE_MS
    lastRequestAt = now
    clearTimeout(timer)
    timer = undefined
    pendingRun = undefined
    spinnerTimer ??= setTimeout(() => {
        if (requested.value) spinning.value = true
    }, SPINNER_AFTER_MS)

    return new Promise<void>((resolve, reject) => {
        settlePrevious = resolve
        // A function, as it is read again after the wait.
        const dropped = () => at !== generation.value || !peek.value
        const run = async () => {
            timer = undefined
            pendingRun = undefined
            const cached = cache.has(key)
            const began = performance.now()
            let entry: PeekedEntry
            try {
                entry = await loadEntry(key)
            } catch (error) {
                if (at !== generation.value) {
                    resolve()
                    return
                }
                settlePrevious = undefined
                leavePeek()
                reject(error instanceof Error ? error : new Error(String(error)))
                return
            }
            if (dropped()) {
                resolve()
                return
            }
            const pending = options.ready?.(entry.state)
            if (pending) {
                await waitReady(pending)
                if (dropped()) {
                    resolve()
                    return
                }
            }
            settlePrevious = undefined
            stopTimers()
            peek.value = {
                source: key,
                state: shown(entry.state, options.audio),
                audio: options.audio,
            }
            displayed.value = key
            peekShown(cached ? undefined : performance.now() - began)
            resolve()
        }
        if (quick) {
            pendingRun = () => {
                clearTimeout(timer)
                void run()
            }
            timer = setTimeout(() => void run(), PEEK_DEBOUNCE_MS)
        } else void run()
    })
}

/**
 * Runs a request that is waiting out the debounce now. The debounce is for repeats of a held
 * key, so the list calls this when the key is released. Does nothing when none waits.
 */
export const runPendingPeek = () => {
    pendingRun?.()
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
    generation.value++
    stopTimers()
    settlePrevious?.()
    settlePrevious = undefined
    requested.value = undefined
    displayed.value = undefined
    if (!peek.value) return
    peek.value = undefined
    for (const listener of [...leftListeners]) listener()
}

// A reset or a stored stack replacing the history ends any peek.
watch(
    peek,
    (value) => {
        if (!value) displayed.value = undefined
        if (value || !requested.value) return
        generation.value++
        stopTimers()
        settlePrevious?.()
        settlePrevious = undefined
        requested.value = undefined
    },
    { flush: 'sync' },
)

let restoreGeneration = 0
let cancelRestore: (() => void) | undefined

/**
 * Restores an entry: the snapshot's chart and level info with the current audio,
 * and its offset when its BGM is the current one (else the current offset stays), pushed as an
 * undoable `restore` entry. Leaves any peek first. When it already matches
 * the current chart, nothing is pushed. Current failures call onFailure synchronously or reject.
 */
export const restoreEntry = async (
    key: EntryKey,
    onFailure?: (error: unknown) => void,
): Promise<void> => {
    const request = ++restoreGeneration
    cancelRestore?.()
    const stack = stackGeneration()
    const fromGeneration = sourceGeneration.value
    const move = stackMoveRequestGeneration.value
    let peekRequest = generation.value
    let content = liveState.value
    let valid = true
    let ownLeave: number | undefined
    let ownState: State | undefined
    let stateExpected = false
    let actionExpected = false
    let stopState: (() => void) | undefined
    let stopAction: (() => void) | undefined

    const dispose = () => {
        stopState?.()
        stopState = undefined
        stopAction?.()
        stopAction = undefined
        if (cancelRestore === invalidate) cancelRestore = undefined
    }
    const invalidate = () => {
        valid = false
        dispose()
    }

    const current = () =>
        valid &&
        request === restoreGeneration &&
        stack === stackGeneration() &&
        fromGeneration === sourceGeneration.value &&
        move === stackMoveRequestGeneration.value &&
        peekRequest === generation.value

    stopState = watch(
        [liveState, generation, sourceGeneration, stackMoveRequestGeneration],
        ([state, nextPeek, nextSource, nextMove]) => {
            if (nextPeek !== peekRequest) {
                if (nextPeek === ownLeave) {
                    ownLeave = undefined
                    peekRequest = nextPeek
                } else {
                    invalidate()
                    return
                }
            }
            if (nextSource !== fromGeneration || nextMove !== move) {
                invalidate()
                return
            }
            if (stateExpected && state === ownState) {
                stateExpected = false
                content = state
            } else if (!sameFileContent(content, state)) invalidate()
        },
        { flush: 'sync' },
    )
    stopAction = onHistoryAction((action) => {
        if (action.kind === 'save' || action.kind === 'export') return
        if (actionExpected && action.kind === 'restore' && action.state === ownState)
            actionExpected = false
        else invalidate()
    })
    cancelRestore = invalidate

    const leave = () => {
        ownLeave = generation.value + 1
        leavePeek()
        ownLeave = undefined
    }
    // The step's offset fits the step's BGM only: after a BGM change the current offset stays.
    const withCurrentAudio = (entry: PeekedEntry): State => {
        const live = liveState.value.bgm
        const sameBgm = live.meta?.hash === entry.state.bgm.meta?.hash
        return {
            ...entry.state,
            bgm: { ...live, offset: sameBgm ? entry.state.bgm.offset : live.offset },
            selectedEntities: [],
        }
    }

    busy(true)
    try {
        const entry = await loadEntry(key)
        if (!current()) return
        const matches = source?.sameSnapshot(withCurrentAudio(entry), liveState.value)
        if (!current()) return
        if (matches) {
            leave()
            if (current()) effects?.alreadyMatches()
            return
        }
        if (!effects) throw new Error('Restore operation factory is not installed')
        const operation = effects.restoredOperation(entry.time)
        if (!current()) return
        leave()
        if (!current()) return
        ownState = withCurrentAudio(entry)
        stateExpected = true
        actionExpected = true
        pushState(operation, ownState, 'restore')
        bump('features.restore')
        stateExpected = false
        actionExpected = false
        if (current()) notifyRestored(entry.time)
    } catch (error) {
        if (!current()) return
        if (!onFailure) throw error
        onFailure(error)
    } finally {
        busy(false)
        dispose()
    }
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
