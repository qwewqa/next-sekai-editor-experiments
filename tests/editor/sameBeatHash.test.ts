import assert from 'node:assert/strict'
import test from 'node:test'
import { toHex } from '../../src/local/hash'
import { toRecords } from '../../src/local/records/records'
import { encodeSnapshot } from '../../src/local/records/snapshot'
import type { State } from '../../src/state'
import type { Transaction } from '../../src/state/transaction'
import { add, baseState, edits, entityAt, kinds, seen, type Kind } from './sameBeatKinds'

// States that play the same (the same chains) hash the same, however they were reached; a
// different same-beat order is another state, with another root.

const root = (state: State) => toHex(encodeSnapshot(toRecords(state)).root.hash)

type Step = (t: Transaction) => unknown

/** Every kind: neighbours at 2 and 6, and at 4 a pair on track 1 and, with tracks, another on 2. */
const direct = (reversed?: Kind) =>
    edits(
        baseState(),
        ...kinds.flatMap((kind): Step[] => {
            const [a, b] = kind === reversed ? [2, 1] : [1, 2]
            return [
                (t) => add(t, kind, 2, 20),
                (t) => add(t, kind, 4, a),
                (t) => add(t, kind, 4, b),
                (t) => add(t, kind, 6, 60),
                ...(kind.track
                    ? [
                          (t: Transaction) => add(t, kind, 4, 11, 2),
                          (t: Transaction) => add(t, kind, 4, 12, 2),
                      ]
                    : []),
            ]
        }),
    )

/** The same chains by another history: kinds in reverse, the pair made backwards then fixed. */
const roundabout = () => {
    let state = baseState()
    for (const kind of [...kinds].reverse()) {
        state = edits(
            state,
            (t) => kind.track && add(t, kind, 4, 11, 2),
            (t) => add(t, kind, 6, 60),
            (t) => add(t, kind, 4, 2),
            (t) => add(t, kind, 4, 99),
            (t) => add(t, kind, 4, 1),
            (t) => kind.track && add(t, kind, 4, 12, 2),
        )
        // 2, 99, 1 becomes 1, 2: 99 goes, and 2 goes and comes back last.
        const before = state
        state = edits(
            state,
            (t) => kind.remove(t, entityAt(before, kind, 4, 99) as never),
            (t) => kind.remove(t, entityAt(before, kind, 4, 2) as never),
            (t) => add(t, kind, 4, 2),
            (t) => add(t, kind, 2, 20),
        )
    }
    return state
}

/** Each bucket's entities at beat 4, as tags, in the grid's own order. */
const bucketOrder = (state: State) =>
    kinds.map((kind) =>
        [...(state.store.grid[kind.type].get(4) ?? [])].map(
            (entity) => (entity as unknown as Record<string, number>)[kind.field],
        ),
    )

test('two histories that reach the same chains give one root hash', () => {
    const a = direct()
    const b = roundabout()
    for (const kind of kinds) {
        assert.deepEqual(seen(b, kind, 4), seen(a, kind, 4), kind.name)
        assert.deepEqual(seen(a, kind, 4), [1, 2], kind.name)
        if (kind.track) assert.deepEqual(seen(b, kind, 4, 2), [11, 12], kind.name)
    }
    // Not vacuous: the grids hold their entities in other orders.
    assert.notDeepEqual(bucketOrder(b), bucketOrder(a))
    assert.notDeepEqual(
        kinds.map((kind) => [...b.store.grid[kind.type].keys()]),
        kinds.map((kind) => [...a.store.grid[kind.type].keys()]),
    )
    assert.equal(root(b), root(a))
})

test('a same-beat pair in the other order hashes differently, kind by kind', () => {
    const roots = new Set([root(direct())])
    for (const kind of kinds) {
        const reversed = direct(kind)
        assert.deepEqual(seen(reversed, kind, 4), [2, 1], kind.name)
        const hash = root(reversed)
        assert.ok(!roots.has(hash), kind.name)
        roots.add(hash)
    }
})
