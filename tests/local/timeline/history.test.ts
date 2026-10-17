import assert from 'node:assert/strict'
import test from 'node:test'
import { onHistoryAction, type HistoryAction } from '../../../src/history/actions'
import {
    canUndo,
    isDirty,
    liveState,
    loadedSlotsForTests,
    markFileEvent,
    peek,
    pushState,
    redoState,
    replaceState,
    resetStates,
    restoreStates,
    setSlotLoader,
    undoState,
} from '../../../src/history/stack'
import type { State } from '../../../src/state'
import { goldenChart, stateOf } from '../records/charts'

// The undo stack's lazy slots and queue rules (§1.6.4 #6): synchronous when the slot is loaded,
// queued and coalesced while it loads, cancelled by an edit or a peek; restored slots bounded by
// an LRU; file events as entries that leave the stack alone.

const base = stateOf(goldenChart())
const states = Array.from({ length: 20 }, (_, i) => ({ ...base, initialLife: 100 + i }))
const hash = (n: number) => new Uint8Array(16).fill(n + 1)
const numberOf = (snapshot: Uint8Array) => (snapshot[0] ?? 0) - 1

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** A loader whose reads finish when the test says. */
const loads = () => {
    const waiting: { n: number; resolve: (state: State) => void }[] = []
    setSlotLoader(
        (snapshot) =>
            new Promise<State>((resolve) => {
                waiting.push({ n: numberOf(snapshot), resolve })
            }),
    )
    return {
        waiting,
        /** Finishes every read so far. */
        finish: async () => {
            await tick()
            for (const { n, resolve } of waiting.splice(0)) resolve(states[n] ?? base)
            await tick()
        },
    }
}

const restore = (count: number, at: number) => {
    restoreStates(
        Array.from({ length: count }, (_, i) => ({
            snapshot: hash(i),
            label: `Step ${i}`,
            isDirty: i > 2,
        })),
        at,

        states[at]!,
    )
}

const watchActions = () => {
    const seen: HistoryAction[] = []
    const stop = onHistoryAction((action) => seen.push(action))
    return { seen, stop }
}

test('a move onto a loaded slot is synchronous; onto a restored one it waits for the slot', async () => {
    const reads = loads()
    restore(10, 9)
    await reads.finish() // the prefetched neighbour
    const { seen, stop } = watchActions()
    // Slot 8 was prefetched: Undo is synchronous.
    assert.equal(undoState()?.(), 'Step 9')
    assert.equal(liveState.value.initialLife, 108)
    // Three presses over slots not loaded: queued and coalesced; the slots passed over aren't read.
    assert.equal(loadedSlotsForTests()[7], false)
    undoState()
    undoState()
    undoState()
    assert.equal(liveState.value.initialLife, 108)
    assert.ok(canUndo.value)
    await reads.finish()
    await reads.finish()
    assert.equal(liveState.value.initialLife, 105)
    assert.equal(loadedSlotsForTests()[6], false)
    assert.deepEqual(
        seen.map((action) => [
            action.kind,
            action.state?.initialLife,
            'snapshot' in action ? action.snapshot?.[0] : undefined,
        ]),
        [
            ['undo', 108, undefined],
            ['undo', 107, undefined],
            ['undo', undefined, 7],
            ['undo', 105, undefined],
        ],
    )
    // Redo past the loaded neighbour queues too, and lands where the presses end.
    redoState()
    redoState()
    await reads.finish()
    await reads.finish()
    assert.equal(liveState.value.initialLife, 107)
    stop()
})

test('an edit cancels pending moves, so it applies to what is on screen', async () => {
    const reads = loads()
    restore(10, 9)
    await reads.finish()
    undoState()
    await reads.finish()
    undoState()
    undoState()
    const { seen, stop } = watchActions()
    // The edit is built from the state on screen, slot 8.
    pushState(() => 'Edit', { ...liveState.value, initialLife: 999 })
    await reads.finish()
    await reads.finish()
    assert.equal(liveState.value.initialLife, 999)
    assert.deepEqual(
        seen.map((action) => action.kind),
        ['edit'],
    )
    stop()
})

test('entering peek cancels pending moves', async () => {
    const reads = loads()
    restore(10, 9)
    await reads.finish()
    undoState()
    undoState()
    undoState()
    peek.value = { source: 'test', state: base }
    await reads.finish()
    await reads.finish()
    peek.value = undefined
    assert.equal(liveState.value.initialLife, 108)
})

test('restored slots outside the head and its neighbours go back to refs past the LRU', async () => {
    const reads = loads()
    restore(20, 19)
    await reads.finish()
    for (let i = 0; i < 18; i++) {
        undoState()
        await reads.finish()
        await reads.finish()
    }
    assert.equal(liveState.value.initialLife, 101)
    const loaded = loadedSlotsForTests()
    assert.ok(loaded[0] && loaded[1] && loaded[2])
    // The LRU of 8 plus the head and its neighbours, at most.
    assert.ok(loaded.filter(Boolean).length <= 8 + 3)
    assert.equal(loaded[19], false)
})

test('a restored slot whose selection changed stays in the LRU', async () => {
    const reads = loads()
    restore(20, 19)
    await reads.finish()
    for (let i = 0; i < 18; i++) {
        undoState()
        await reads.finish()
        await reads.finish()
        // A click on the slot: its state is replaced, its chart and stored root kept.
        replaceState({ ...liveState.value })
    }
    assert.equal(liveState.value.initialLife, 101)
    const loaded = loadedSlotsForTests()
    assert.ok(loaded.filter(Boolean).length <= 8 + 3)
    assert.equal(loaded[19], false)
})

test('a slot keeps isDirty while unloaded, for the leave prompt', async () => {
    const reads = loads()
    restore(6, 5)
    await reads.finish()
    assert.equal(isDirty.value, true)
    undoState()
    undoState()
    undoState()
    await reads.finish()
    await reads.finish()
    assert.equal(isDirty.value, false)
})

test('a file event is an entry on the current state that leaves the stack alone', () => {
    resetStates({ isDirty: false, name: () => 'Initialize', state: base })
    pushState(() => 'B', states[1]!)
    const { seen, stop } = watchActions()
    markFileEvent('export', () => 'Exported coconut.nsld')
    stop()
    assert.equal(seen.length, 1)
    assert.equal(seen[0]?.kind, 'export')
    assert.equal(seen[0]?.state, states[1])
    assert.equal(seen[0]?.name(), 'Exported coconut.nsld')
    assert.equal(liveState.value, states[1])
    assert.ok(canUndo.value)
})
