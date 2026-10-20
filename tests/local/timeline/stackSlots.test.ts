import assert from 'node:assert/strict'
import test from 'node:test'
import {
    headSnapshot,
    liveState,
    loadedStates,
    pushState,
    replaceState,
    resetStates,
    restoredLoadedForTests,
    restoreStates,
    setSlotLoader,
    undoState,
} from '../../../src/history/stack'
import type { State } from '../../../src/state'
import { editStep, futureFixtureOperation, initialLife } from '../../helpers/historySteps'
import { goldenChart, stateOf } from '../records/charts'

// The restored slots of the undo stack: the LRU holds only slots still in the stack (HS-4), and
// a replacement keeps a slot's stored root only while the chart is the one it names (HS-5).

const base = stateOf(goldenChart())
const states = Array.from({ length: 20 }, (_, i) => ({ ...base, initialLife: 100 + i }))
const hash = (n: number) => new Uint8Array(16).fill(n + 1)
const numberOf = (snapshot: Uint8Array) => (snapshot[0] ?? 0) - 1
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

const loads = () => {
    const waiting: { n: number; resolve: (state: State) => void }[] = []
    setSlotLoader(
        (snapshot) =>
            new Promise<State>((resolve) => {
                waiting.push({ n: numberOf(snapshot), resolve })
            }),
    )
    return {
        finish: async () => {
            await tick()
            for (const { n, resolve } of waiting.splice(0)) resolve(states[n] ?? base)
            await tick()
        },
    }
}

/** Loaded slots of the stack that have a stored root. */
const held = () => loadedStates().filter(({ snapshot }) => snapshot).length

const restore = (count: number, at: number) => {
    restoreStates(
        Array.from({ length: count }, (_, i) => ({
            snapshot: hash(i),
            step: editStep(futureFixtureOperation(`Step ${i}`)),
            isDirty: false,
        })),
        at,
        states[at]!,
    )
}

test('HS-4: an edit past undone steps drops their slots from the restored-slot LRU', async () => {
    const reads = loads()
    restore(20, 19)
    for (let i = 0; i < 3; i++) {
        undoState()
        await reads.finish()
        await reads.finish()
    }
    assert.equal(liveState.value.initialLife, 116)
    assert.ok(restoredLoadedForTests() > 1, 'the undone slots are held')
    pushState(initialLife(116, 999), { ...liveState.value, initialLife: 999 })
    // The LRU holds exactly the loaded restored slots still in the stack.
    assert.ok(held() >= 1)
    assert.equal(restoredLoadedForTests(), held())
})

test('HS-4: a read that lands after the stack was replaced is not held', async () => {
    const reads = loads()
    restore(20, 19)
    undoState()
    resetStates({
        isDirty: false,
        state: { ...base, initialLife: 1 },
        step: editStep(futureFixtureOperation('Fresh')),
    })
    await reads.finish()
    await reads.finish()
    assert.equal(held(), 0)
    assert.equal(restoredLoadedForTests(), 0)
})

test('HS-5: a selection-only replacement keeps the slot’s stored root', () => {
    loads()
    restore(5, 4)
    const root = headSnapshot.value
    assert.ok(root)
    replaceState({ ...liveState.value, selectedEntities: [] })
    assert.deepEqual(headSnapshot.value, root)
    assert.equal(restoredLoadedForTests(), 1)
})

test('HS-5: a replacement that changes the chart does not keep a root naming another chart', () => {
    loads()
    restore(5, 4)
    assert.ok(headSnapshot.value)
    replaceState({ ...liveState.value, initialLife: 555 })
    assert.equal(headSnapshot.value, undefined)
    assert.equal(liveState.value.initialLife, 555)
    assert.equal(restoredLoadedForTests(), 0)
})
