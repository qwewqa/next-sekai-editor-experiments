import type { CommandName } from '../editor/commands'
import type { RawData, Source } from './catalogue'
import { bucket } from './scales'

// The usage statistics' counters: the only analytics code on the edit and command paths. Every
// call returns at once while analytics is off, and otherwise bumps a Map entry, so a hook costs
// O(1) with no await or I/O. The client (client.ts), loaded later, sends their counts.

/** Most distinct counters at once, of which up to USAGE_LIMIT may be `usage` counters. */
export const KEY_LIMIT = 1000
export const USAGE_LIMIT = 900
/** Most per-action events held until the client takes them. */
export const RECORD_LIMIT = 50
const CAP = 9999

let enabled = false
const counts = new Map<string, number>()
let usageKeys = 0
// The wheel counts once a visit, never per tick.
const wheelSeen = new Set<string>()
type Recorded = {
    name: string
    data: Record<string, unknown>
    at: number
    /** The device the action ran on, read when it was recorded. */
    device?: Record<string, unknown>
}
let recorded: Recorded[] = []
/** The client's read of the device an event ran on; it gives nothing for an event with none. */
let readDevice: ((name: string) => Record<string, unknown> | undefined) | undefined

export const isEnabled = () => enabled

/** Adds to a counter, `<event>.<key>`, such as `notices.error`. */
export const bump = (key: string, by = 1) => {
    if (!enabled) return
    const now = counts.get(key)
    if (now !== undefined) {
        counts.set(key, Math.min(now + by, CAP))
        return
    }
    const usage = key.startsWith('usage.')
    if (counts.size >= KEY_LIMIT || (usage && usageKeys >= USAGE_LIMIT)) return
    if (usage) usageKeys++
    counts.set(key, Math.min(by, CAP))
}

/** One press of a command. A command run by another command, or a held key's repeat, is not one. */
export const bumpCommand = (name: CommandName, source: Source) => {
    if (!enabled || source === 'nested' || source === 'repeat') return
    const key = `usage.${name}.${source}`
    if (source === 'wheel') {
        if (wheelSeen.has(key)) return
        wheelSeen.add(key)
    }
    bump(key)
}

/** The events a flow records as they happen: `open`, `save`, `export`, `check`, `bgm` and `preview`. */
type Recordable = 'open' | 'save' | 'export' | 'check' | 'bgm' | 'preview'

/**
 * A per-action event, such as a Save's outcome, kept until the client sends it. Sizes and times
 * are plain numbers here; the client makes them ranges. `since` is the `performance.now()` the
 * action began (after its last picker or dialog closed), which gives `took`.
 */
export const record = <E extends Recordable>(
    name: E,
    data: RawData<E> & { took?: number },
    since?: number,
) => {
    if (!enabled || recorded.length >= RECORD_LIMIT) return
    const took = since === undefined ? {} : { took: performance.now() - since }
    recorded.push({ name, data: { ...data, ...took }, at: Date.now(), device: readDevice?.(name) })
}

/**
 * Installs the reader of the device an event ran on (device.ts), which `record` calls as the
 * action ends: a few reads, so a resize before the send does not relabel it. start.ts installs it
 * with the counting, before the client loads.
 */
export const watchDevice = (reader: typeof readDevice) => {
    readDevice = reader
}

/** A Timeline step shown: from the cache when `ms` is undefined, else after that many milliseconds. */
export const peekShown = (ms: number | undefined) => {
    if (!enabled) return
    bump('features.peek')
    bump(ms === undefined ? 'peek.peek.cached' : `peek.peek.${bucket('peek', ms)}`)
}

let busyCount = 0
/** An Open, Save, Restore, Check or BGM load is running, which the long frames are sorted by. */
export const busy = (on: boolean) => {
    const was = busyCount > 0
    busyCount = Math.max(0, busyCount + (on ? 1 : -1))
    if (was !== busyCount > 0) onBusyChange?.(!was)
}
export const isBusy = () => busyCount > 0
let onBusyChange: ((busy: boolean) => void) | undefined
/** Calls back when the editor becomes busy or stops being; the client keeps the times. */
export const watchBusy = (listener: ((busy: boolean) => void) | undefined) => {
    onBusyChange = listener
}

export type Startup = { outcome: 'done' | 'slow' | 'error'; at: number; hidden: boolean }
let started: Startup | undefined
/**
 * Startup ended: when, how, and whether the page was ever hidden before then (a hidden page is
 * throttled, which inflates the time). A few reads, once a visit.
 */
export const markStartup = (outcome: Startup['outcome']) => {
    if (!enabled || started) return
    const at = performance.now()
    const hidden =
        document.visibilityState !== 'visible' ||
        performance.getEntriesByType('visibility-state').some((entry) => entry.name === 'hidden')
    started = { outcome, at, hidden }
}
export const startup = () => started

/** Facts the start events report: the tab reloaded its own session; the editor's graphics failed. */
const noted = new Set<'reload' | 'graphicsUnavailable'>()
export const note = (what: 'reload' | 'graphicsUnavailable') => {
    if (enabled) noted.add(what)
}
export const wasNoted = (what: 'reload' | 'graphicsUnavailable') => noted.has(what)

export type ChartTrigger = 'open' | 'restore' | 'save'
const charts = new Set<ChartTrigger>()
let onChart: (() => void) | undefined
/** The chart became current or was saved; the client counts its objects when it is idle. */
export const chartChanged = (trigger: ChartTrigger) => {
    if (!enabled) return
    charts.add(trigger)
    onChart?.()
}
export const hasCharts = () => charts.size > 0
/** The triggers since the last call. */
export const takeCharts = () => {
    const taken = [...charts]
    charts.clear()
    return taken
}
export const watchCharts = (listener: (() => void) | undefined) => {
    onChart = listener
}

/** The counters and events since the last call, which then start again from nothing. */
export const collect = () => {
    const taken = { counts: new Map(counts), recorded }
    counts.clear()
    usageKeys = 0
    recorded = []
    return taken
}

// Engaged visits only: nothing is sent until the first trusted input while the page is visible.
const ARM_EVENTS = ['pointerdown', 'keydown', 'touchstart', 'wheel'] as const
const listenOptions = { capture: true, passive: true } as const
let armedAt: number | undefined
const armListeners = new Set<() => void>()
let armingHeld = false

const arm = (event: Event) => {
    // While held the listeners stay, for the input after the release.
    if (armingHeld || !event.isTrusted || document.visibilityState !== 'visible') return
    armedAt = performance.now()
    for (const type of ARM_EVENTS) window.removeEventListener(type, arm, listenOptions)
    for (const listener of [...armListeners]) listener()
}

/**
 * While held, no input arms the visit: on a load where the first-visit dialog is due, from
 * module evaluation until the dialog is skipped or closed.
 */
export const holdArming = (held: boolean) => {
    armingHeld = held
}

/** When the visit was armed, by `performance.now()`; undefined until then. */
export const armedTime = () => armedAt

/** Calls back once the visit is armed. */
export const onArmed = (listener: () => void) => {
    armListeners.add(listener)
    return () => {
        armListeners.delete(listener)
    }
}

/** Starts counting, and listens for the input that arms the visit. */
export const enable = () => {
    if (enabled) return
    enabled = true
    if (armedAt === undefined && typeof window !== 'undefined')
        for (const type of ARM_EVENTS) window.addEventListener(type, arm, listenOptions)
}

/** Stops counting and forgets what was counted. An armed visit stays armed. */
export const disable = () => {
    enabled = false
    collect()
    wheelSeen.clear()
    noted.clear()
    charts.clear()
    if (typeof window !== 'undefined')
        for (const type of ARM_EVENTS) window.removeEventListener(type, arm, listenOptions)
}
