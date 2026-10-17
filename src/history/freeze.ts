import type { State } from '../state'

// Published states are never changed in place: the flush's identity memo finds an unchanged kind
// by its maps' identity and an unchanged entity by its own (Part 1 §1.6.2), so a change in place
// would store a stale record under a valid hash. In development and tests every state the undo
// stack publishes has its store frozen, maps and sets included, so such a change throws where
// it's made. Release builds skip it.

const published = new WeakSet<object>()
let guarded = false

/** Maps and sets can't be frozen: their writers refuse a published one instead. */
const guardCollections = () => {
    if (guarded) return
    guarded = true
    const guard = (prototype: object, names: readonly string[]) => {
        const methods = prototype as Record<string, (...args: unknown[]) => unknown>
        for (const name of names) {
            const original = methods[name]
            if (!original) continue
            methods[name] = function (this: object, ...args: unknown[]) {
                if (published.has(this))
                    throw new TypeError(`A published state was changed in place (${name})`)
                return original.apply(this, args)
            }
        }
    }
    guard(Map.prototype, ['set', 'delete', 'clear'])
    guard(Set.prototype, ['add', 'delete', 'clear'])
}

const isPlain = (value: object) => {
    const prototype = Object.getPrototypeOf(value) as unknown
    return prototype === Object.prototype || prototype === Array.prototype || prototype === null
}

/** Freezes what's reachable from value; parts already frozen are shared and skipped. */
const freezeAll = (value: unknown) => {
    const stack = [value]
    while (stack.length) {
        const next = stack.pop()
        if (typeof next !== 'object' || next === null) continue
        if (next instanceof Map || next instanceof Set) {
            if (published.has(next)) continue
            published.add(next)
            if (next instanceof Map)
                for (const [key, item] of next as Map<unknown, unknown>) stack.push(key, item)
            else for (const item of next as Set<unknown>) stack.push(item)
            continue
        }
        if (!isPlain(next) || Object.isFrozen(next)) continue
        Object.freeze(next)
        for (const item of Object.values(next)) stack.push(item)
    }
}

/** Freezes a state's store as it's published, outside release builds. */
export const freezePublished = (state: State) => {
    guardCollections()
    freezeAll(state.store)
}
