import assert from 'node:assert/strict'
import test from 'node:test'
import { collectConnectors, collectNotes, orderConnectors } from '../../../src/editor/minimap/paint'
import { chartState, note } from '../chartFixture'

/** A fixed permutation: the order must not depend on the input order. */
const shuffled = <T>(items: readonly T[]) => {
    const result = [...items]
    let seed = 7
    for (let i = result.length - 1; i > 0; i--) {
        seed = (seed * 48271) % 2147483647
        const j = seed % (i + 1)
        const a = result[i] as T
        result[i] = result[j] as T
        result[j] = a
    }
    return result
}

const state = chartState([
    [note(6, -4), note(12, 1)],
    [note(2, 0), note(9, -2)],
    [note(2, 3), note(5, 1)],
    // Zero length: not a visible body.
    [note(7), note(7, 2)],
    [
        note(4, 0, { connectorType: 'guide', connectorGuideAlpha: 0 }),
        note(8, 0, { connectorType: 'guide', connectorGuideAlpha: 0 }),
    ],
    [note(11, 1)],
    [note(3.2), note(3.7), note(3.4)],
])
const connectors = [...state.store.slides.connector.values()].flat()

test('bodies are ordered by head beat, then slide, whatever the input order', () => {
    const sorted = orderConnectors(connectors)
    assert.deepEqual(orderConnectors(shuffled(connectors)), sorted)
    assert.deepEqual(orderConnectors([...connectors].reverse()), sorted)
    for (let i = 1; i < sorted.length; i++) {
        const a = sorted[i - 1]
        const b = sorted[i]
        assert.ok(a && b)
        assert.ok(
            a.head.beat < b.head.beat ||
                (a.head.beat === b.head.beat && a.head.slideId < b.head.slideId),
        )
    }
})

test('zero-length bodies and invisible guides are left out', () => {
    const sorted = orderConnectors(connectors)
    assert.ok(sorted.length >= 4)
    assert.ok(sorted.every((connector) => connector.tail.beat > connector.head.beat))
    assert.ok(sorted.every((connector) => connector.segmentHead.connectorType !== 'guide'))
})

test('two bodies from different slides at one beat keep a fixed order', () => {
    const same = orderConnectors(connectors).filter((connector) => connector.head.beat === 2)
    assert.equal(same.length, 2)
    assert.ok((same[0]?.head.slideId ?? 0) < (same[1]?.head.slideId ?? 0))
})

test('notes come by ascending key, then bucket order, whatever the keys were inserted in', () => {
    const grid = state.store.grid.note
    const reordered = new Map([...grid].reverse())
    assert.notDeepEqual([...grid.keys()], [...reordered.keys()])
    const expected = collectNotes(grid, -Infinity, Infinity)
    assert.deepEqual(collectNotes(reordered, -Infinity, Infinity), expected)
    const keys = expected.map((entity) => Math.floor(entity.beat))
    assert.deepEqual(
        keys,
        [...keys].sort((a, b) => a - b),
    )
    // Inside a bucket the order is the bucket's own: 3.2, 3.7, 3.4 as added.
    assert.deepEqual(
        expected.filter((entity) => Math.floor(entity.beat) === 3).map((entity) => entity.beat),
        [3.2, 3.7, 3.4],
    )
})

test('a key range picks the same notes and bodies in the same order as the full set', () => {
    const all = collectNotes(state.store.grid.note, -Infinity, Infinity)
    assert.deepEqual(
        collectNotes(state.store.grid.note, 5, 9),
        all.filter((entity) => entity.beat >= 5 && entity.beat < 10),
    )
    const some = collectConnectors(state.store.grid.connector, 5, 9)
    const full = collectConnectors(state.store.grid.connector, -Infinity, Infinity)
    assert.deepEqual(
        some,
        full.filter((connector) => some.includes(connector)),
    )
    // A body crossing the range is found once, from any of its keys.
    assert.equal(new Set(some).size, some.length)
})
