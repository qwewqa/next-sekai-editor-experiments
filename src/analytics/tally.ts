import type { CommandName } from '../editor/commands'
import type { EventData, Source } from './catalogue'

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
type Recorded = { name: string; data: Record<string, unknown>; at: number }
let recorded: Recorded[] = []

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

/** A per-action event, such as a Save's outcome, kept until the client sends it. */
export const record = <E extends 'open' | 'save' | 'export' | 'check' | 'bgm' | 'chart'>(
    name: E,
    data: EventData<E>,
) => {
    if (!enabled || recorded.length >= RECORD_LIMIT) return
    recorded.push({ name, data, at: Date.now() })
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

const arm = (event: Event) => {
    if (!event.isTrusted || document.visibilityState !== 'visible') return
    armedAt = performance.now()
    for (const type of ARM_EVENTS) window.removeEventListener(type, arm, listenOptions)
    for (const listener of [...armListeners]) listener()
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
    if (typeof window !== 'undefined')
        for (const type of ARM_EVENTS) window.removeEventListener(type, arm, listenOptions)
}
