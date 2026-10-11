import assert from 'node:assert/strict'
import test from 'node:test'
import { stepTapCycle, tapCycleSlack, type TapCycle } from '../../src/editor/tapCycle'

// A point is a tap's x in px; taps within the slack are the same spot.
const near = (a: number, b: number) => Math.abs(a - b) <= tapCycleSlack

/** Taps at the points, each hitting its set; returns the picks. */
const tapAll = (taps: { at: number; set: string[] }[], start?: string) => {
    let cycle: TapCycle<string, number> | undefined
    let current = start
    return taps.map(({ at, set }) => {
        const step = stepTapCycle(cycle, set, current, at, near)
        cycle = step.cycle
        current = step.target
        return current
    })
}

test('a still pointer laps the set top to bottom', () => {
    const taps = Array.from({ length: 7 }, () => ({ at: 0, set: ['a', 'b', 'c'] }))
    assert.deepEqual(tapAll(taps), ['a', 'b', 'c', 'a', 'b', 'c', 'a'])
    // Another spot starts at its top.
    assert.deepEqual(tapAll([{ at: 10, set: ['b', 'c'] }], 'a'), ['b'])
})

/** Taps alternating a pixel either side of a point; checks every object comes within 2n taps. */
const expectEveryLap = (at0: string[], at1: string[]) => {
    // 2 px apart, with the float error the EE's lane scale gives.
    const taps = Array.from({ length: 40 }, (_, i) =>
        i % 2 ? { at: 2.0000001, set: at1 } : { at: 0, set: at0 },
    )
    const picks = tapAll(taps)
    const objects = [...new Set([...at0, ...at1])]
    for (const object of objects) {
        const at = picks.flatMap((pick, i) => (pick === object ? [i] : []))
        const gaps = at.map((i, k) => i - (at[k - 1] ?? -1))
        assert.ok(
            Math.max(...gaps, picks.length - at.at(-1)!) <= 2 * objects.length,
            `${object}: ${picks.join()}`,
        )
    }
}

test('one-pixel jitter reaches every object, each lap', () => {
    // At 0 the time scale t1 is in reach, at 1 t2 instead: one comes as the other goes.
    expectEveryLap(['a', 't1', 'b', 'c'], ['a', 'b', 't2', 'c'])
    // x is in reach every other tap, which isn't always its turn.
    expectEveryLap(['a', 'x', 'b'], ['a', 'b'])
    // Each pick of x or y goes out of reach at the next tap.
    expectEveryLap(['x', 'a', 'b'], ['y', 'a', 'b'])
})

test('an object out of reach keeps its place, and leaves after 8 taps', () => {
    // b is out of reach at the second tap only; it's taken when back, then the order goes on.
    const picks = tapAll([
        { at: 0, set: ['a', 'b', 'c'] },
        { at: 1, set: ['a', 'c'] },
        { at: 0, set: ['a', 'b', 'c'] },
        { at: 0, set: ['a', 'b', 'c'] },
        { at: 0, set: ['a', 'b', 'c'] },
    ])
    assert.deepEqual(picks, ['a', 'c', 'b', 'c', 'a'])
    let cycle: TapCycle<string, number> | undefined
    let current: string | undefined
    for (const set of [['a', 'b'], ...Array.from({ length: 8 }, () => ['a'])]) {
        const step = stepTapCycle(cycle, set, current, 0, near)
        cycle = step.cycle
        current = step.target
    }
    assert.deepEqual([...cycle!.misses.keys()], ['a'])
})

test('the current pick out of reach continues near the last tap, not further away', () => {
    const first = { at: 0, set: ['a', 'x', 'b'] }
    // x is out of reach within the slack: the cycle goes on after it.
    const within = { at: tapCycleSlack, set: ['a', 'b'] }
    assert.deepEqual(tapAll([first, first, within]), ['a', 'x', 'b'])
    // Past it is another spot: its top.
    const past = tapCycleSlack + 0.5
    assert.deepEqual(tapAll([first, first, { at: past, set: ['b', 'a'] }]), ['a', 'x', 'b'])
    assert.deepEqual(tapAll([first, first, { at: past, set: ['a', 'b'] }]), ['a', 'x', 'a'])
})

/** The rule before the slack: the hit objects of the last order, then new ones; the next after the pick. */
const tapAllOld = (taps: { set: string[] }[]) => {
    let order: string[] = []
    let current: string | undefined
    return taps.map(({ set }) => {
        const kept =
            current && set.includes(current) && order.includes(current)
                ? order.filter((entity) => set.includes(entity))
                : []
        order = [...kept, ...set.filter((entity) => !kept.includes(entity))]
        current = order[current ? (order.indexOf(current) + 1) % order.length : 0]
        return current
    })
}

test('taps further apart than the slack pick as before it', () => {
    // A lap at A doesn't carry over a move to B and back.
    const a = { at: 0, set: ['n1', 'n2', 'n3'] }
    const lap = [a, a, { at: 10, set: ['n1', 'n2'] }, a]
    assert.deepEqual(tapAll(lap), ['n1', 'n2', 'n1', 'n2'])
    // Objects out of reach at B don't keep their places from A at C.
    const p = { at: 0, set: ['p', 'q', 'r', 's'] }
    const places = [p, p, { at: 10, set: ['q'] }, { at: 20, set: ['p', 's', 'q'] }]
    assert.deepEqual(tapAll(places), ['p', 'q', 'q', 'p'])
    // Random stacks, each tap at the last point or another spot.
    let seed = 1
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    for (let k = 0; k < 2000; k++) {
        const ids = ['a', 'b', 'c', 'd', 'e'].filter(() => random() < 0.8)
        const taps = Array.from({ length: 12 }, (_, i) => ({
            at: i * 10 * Math.floor(random() * 2),
            set: ids.filter(() => random() < 0.6),
        }))
        for (let i = 1; i < taps.length; i++)
            if (taps[i]!.at === 0 && taps[i - 1]!.at === 0) taps[i]!.set = taps[i - 1]!.set
        assert.deepEqual(tapAll(taps), tapAllOld(taps), JSON.stringify(taps))
    }
})

test('a selection made another way starts a lap from it; without the cycle, from the set', () => {
    const set = ['a', 'b', 'c']
    const first = stepTapCycle(undefined, set, undefined, 0, near)
    assert.equal(first.target, 'a')
    // c, selected some other way, is in the cycle: the next after it.
    assert.equal(stepTapCycle(first.cycle, set, 'c', 0, near).target, 'a')
    // Not in the cycle, or about to be replaced: the next after it in the set, or the top.
    assert.equal(stepTapCycle(first.cycle, set, 'b', 0, near, false).target, 'c')
    assert.equal(stepTapCycle(first.cycle, set, 'z', 0, near).target, 'a')
})
