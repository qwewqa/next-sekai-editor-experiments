/**
 * A cycle of taps through a spot's overlapping objects. Each object hit keeps its place while a
 * pixel of jitter takes it out of reach, and each lap picks every object once.
 */
export type TapCycle<T, P> = {
    // The order taps step through, with how many taps in a row missed each.
    misses: Map<T, number>
    // The objects picked in this lap.
    picked: Set<T>
    last: T | undefined
    point: P
}

// Taps this close to the last one are the same spot, even with its pick out of reach.
export const tapCycleSlack = 3

// Within the slack, an object out of reach for this many taps leaves the order, unless it is the pick.
const maxMisses = 8

/**
 * What a tap at `point` selects among the `set` it hits: the next object after `current`, the
 * selection's first, or with the selection elsewhere the top one. Returns the cycle a tap keeps.
 */
export const stepTapCycle = <T, P>(
    cycle: TapCycle<T, P> | undefined,
    set: readonly T[],
    current: T | undefined,
    point: P,
    isNear: (a: P, b: P) => boolean,
    canContinue = true,
): { target: T | undefined; cycle: TapCycle<T, P> } => {
    const far = !cycle || !isNear(cycle.point, point)
    if (
        !canContinue ||
        current === undefined ||
        !cycle?.misses.has(current) ||
        (far && !set.includes(current))
    ) {
        const target = set[(set.indexOf(current as T) + 1) % set.length]
        return {
            target,
            cycle: {
                misses: new Map(set.map((entity) => [entity, 0])),
                picked: new Set(target === undefined ? [] : [target]),
                last: target,
                point,
            },
        }
    }

    // Beyond the slack it steps as before it: the hit objects in their order, then new ones, from a new lap.
    const hit = new Set(set)
    const misses = new Map<T, number>()
    for (const [entity, count] of cycle.misses) {
        const missed = hit.has(entity) ? 0 : count + 1
        if (missed < (far ? 1 : maxMisses) || entity === current) misses.set(entity, missed)
    }
    for (const entity of set) misses.set(entity, 0)
    const order = [...misses.keys()]

    // A selection changed some other way starts a lap from it.
    let picked = new Set(
        !far && cycle.last === current
            ? [...cycle.picked].filter((entity) => misses.has(entity))
            : [current],
    )
    const from = order.indexOf(current) + 1
    const after = [...order.slice(from), ...order.slice(0, from)]
    const next = (unpicked: boolean) =>
        after.find((entity) => hit.has(entity) && !(unpicked && picked.has(entity)))
    let target = next(true)
    if (target === undefined) {
        target = next(false)
        // With every object picked, the next lap begins.
        if (order.every((entity) => picked.has(entity))) picked = new Set()
    }
    if (target !== undefined) picked.add(target)
    return { target, cycle: { misses, picked, last: target, point } }
}
