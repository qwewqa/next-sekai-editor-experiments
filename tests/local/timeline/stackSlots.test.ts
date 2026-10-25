import assert from 'node:assert/strict'
import test from 'node:test'
import { STACK_CAP } from '../../../src/history/cap'
import {
    canRedo,
    canUndo,
    earlierSteps,
    headSnapshot,
    headStep,
    liveState,
    loadedStates,
    pushState,
    redoState,
    replaceState,
    resetStates,
    restoredLoadedForTests,
    restoreStates,
    setSlotLoader,
    undoState,
} from '../../../src/history/stack'
import type { State } from '../../../src/state'
import {
    editStep,
    futureFixtureOperation,
    initialLife,
    initialStep,
} from '../../helpers/historySteps'
import { goldenChart, stateOf } from '../records/charts'

// The restored slots of the undo stack: the LRU holds only slots still in the stack, and
// a replacement keeps a slot's stored root only while the chart is the one it names. The stack
// keeps at most `STACK_CAP` slots, in the tab and when restored.

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

test('an edit past undone steps drops their slots from the restored-slot LRU', async () => {
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

test('a read that lands after the stack was replaced is not held', async () => {
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

test('a selection-only replacement keeps the slot’s stored root', () => {
    loads()
    restore(5, 4)
    const root = headSnapshot.value
    assert.ok(root)
    replaceState({ ...liveState.value, selectedEntities: [] })
    assert.deepEqual(headSnapshot.value, root)
    assert.equal(restoredLoadedForTests(), 1)
})

test('a replacement that changes the chart does not keep a root naming another chart', () => {
    loads()
    restore(5, 4)
    assert.ok(headSnapshot.value)
    replaceState({ ...liveState.value, initialLife: 555 })
    assert.equal(headSnapshot.value, undefined)
    assert.equal(liveState.value.initialLife, 555)
    assert.equal(restoredLoadedForTests(), 0)
})

/** Undoes as far as it goes, then redoes as far as it goes, counting both. */
const reach = async () => {
    const settle = () => new Promise((resolve) => setImmediate(resolve))
    let undos = 0
    for (; canUndo.value; undos++) {
        undoState()
        await settle()
    }
    let redos = 0
    for (; canRedo.value; redos++) {
        redoState()
        await settle()
    }
    return { undos, redos }
}

test('a push at the cap drops the oldest slot, and Undo stops at the cap', () => {
    resetStates({ isDirty: false, state: { ...base, initialLife: 0 }, step: initialStep() })
    for (let life = 1; life <= STACK_CAP; life++)
        pushState(initialLife(life - 1, life), { ...liveState.value, initialLife: life })
    // 1,001 states pushed: the first is gone, and Undo shows that earlier steps are in History.
    assert.equal(earlierSteps.value, true)
    let undos = 0
    for (; canUndo.value; undos++) undoState()
    assert.equal(undos, STACK_CAP - 1)
    assert.equal(liveState.value.initialLife, 1)
    assert.equal(undoState(), undefined)
})

test('a restored stack over the cap is cut to it around the index', async () => {
    setSlotLoader(() => Promise.resolve(base))
    const slots = Array.from({ length: STACK_CAP + 500 }, (_, i) => ({
        snapshot: hash(i % 200),
        step: editStep(futureFixtureOperation(`Step ${i}`)),
        isDirty: false,
    }))
    // The index among the newest slots: the oldest are cut, and Undo past them says so.
    restoreStates(slots, STACK_CAP + 200, base)
    assert.deepEqual(headStep.value, slots[STACK_CAP + 200]!.step)
    assert.equal(earlierSteps.value, true)
    assert.deepEqual(await reach(), { undos: 700, redos: STACK_CAP - 1 })
    // The index below them: the redo end is cut first, and the stack starts at its first slot.
    restoreStates(slots, 200, base)
    assert.deepEqual(headStep.value, slots[200]!.step)
    assert.equal(earlierSteps.value, false)
    assert.deepEqual(await reach(), { undos: 200, redos: STACK_CAP - 1 })
})
