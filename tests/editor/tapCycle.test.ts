import assert from 'node:assert/strict'
import test from 'node:test'
import { stepTapCycle, type TapCycle } from '../../src/editor/tapCycle'

// A point is a tap's x; taps within 2 apart are the same spot.
const near = (a: number, b: number) => Math.abs(a - b) <= 2

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

/** Taps alternating between two points a pixel apart; checks every object comes within 2n taps. */
const expectEveryLap = (at0: string[], at1: string[]) => {
    const taps = Array.from({ length: 40 }, (_, i) =>
        i % 2 ? { at: 1, set: at1 } : { at: 0, set: at0 },
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
    // x is out of reach 1 away: the cycle goes on after it.
    assert.deepEqual(tapAll([first, first, { at: 1, set: ['a', 'b'] }]), ['a', 'x', 'b'])
    // 3 away is another spot: its top.
    assert.deepEqual(tapAll([first, first, { at: 3, set: ['b', 'a'] }]), ['a', 'x', 'b'])
    assert.deepEqual(tapAll([first, first, { at: 3, set: ['a', 'b'] }]), ['a', 'x', 'a'])
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
