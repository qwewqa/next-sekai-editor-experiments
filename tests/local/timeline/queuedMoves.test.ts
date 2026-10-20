import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { onHistoryAction, type HistoryAction } from '../../../src/history/actions'
import { equalJson } from '../../../src/history/operations'
import * as stack from '../../../src/history/stack'
import {
    liveState,
    peek,
    pushState,
    redoState,
    restoreStates,
    setSlotLoader,
    slotLoading,
    undoState,
} from '../../../src/history/stack'
import type { State } from '../../../src/state'
import { editStep, futureFixtureOperation, initialLife } from '../../helpers/historySteps'
import { goldenChart, stateOf } from '../records/charts'

// The queued moves of the undo stack (plan §1.6.4 #6), the D2 test plan's Q1: how a press that
// waits for its slot settles, and what the stack tells the caller that must notify (DEF-2).
// timeline/history.test.ts holds the lazy-slot basics; this file does not repeat them.

const base = stateOf(goldenChart())
const states = Array.from({ length: 20 }, (_, i) => ({ ...base, initialLife: 100 + i }))
const hash = (n: number) => new Uint8Array(16).fill(n + 1)
const numberOf = (snapshot: Uint8Array) => (snapshot[0] ?? 0) - 1

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
/** Lets the promise callbacks queued so far run, without a timer (fake timers may be on). */
const microtasks = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
}

/** A loader whose reads finish, or fail, when the test says. */
const loads = () => {
    const waiting: { n: number; resolve: (state: State) => void; reject: (e: Error) => void }[] = []
    let reads = 0
    setSlotLoader(
        (snapshot) =>
            new Promise<State>((resolve, reject) => {
                reads++
                waiting.push({ n: numberOf(snapshot), resolve, reject })
            }),
    )
    return {
        waiting,
        reads: () => reads,
        finish: async () => {
            await tick()
            for (const { n, resolve } of waiting.splice(0)) resolve(states[n] ?? base)
            await tick()
        },
        fail: async () => {
            await tick()
            for (const { reject } of waiting.splice(0)) reject(new Error('unreadable'))
            await tick()
        },
        /** For fake timers: the same as `finish`, with no timer. */
        finishNow: async () => {
            for (const { n, resolve } of waiting.splice(0)) resolve(states[n] ?? base)
            await microtasks()
        },
    }
}

/** A stack of `count` stored slots with the head at `at`; the slots but the head are not loaded. */
const restore = (count: number, at: number) => {
    restoreStates(
        Array.from({ length: count }, (_, i) => ({
            snapshot: hash(i),
            step: editStep(futureFixtureOperation(`Step ${i}`)),
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

/** Runs `body` with the stack's load failure log silenced. */
const quietly = async (body: () => Promise<void>) => {
    const log = mock.method(console, 'error', () => undefined)
    try {
        await body()
    } finally {
        log.mock.restore()
    }
}

test('Q1a: three Undo presses and one Redo press over a loading slot settle to a net of two', async () => {
    const reads = loads()
    restore(10, 9)
    const { seen, stop } = watchActions()
    // The neighbour is not loaded yet, so every press queues.
    undoState()
    undoState()
    undoState()
    redoState()
    assert.equal(liveState.value.initialLife, 109)
    await reads.finish()
    await reads.finish()
    stop()
    assert.equal(liveState.value.initialLife, 107)
    assert.deepEqual(
        seen.map((action) => action.kind),
        ['undo', 'undo'],
    )
    assert.equal(slotLoading.value, false)
})

test('Q1b: a loader rejection clears the pending moves, changes nothing, and a later press retries', async () => {
    await quietly(async () => {
        const reads = loads()
        restore(10, 9)
        const { seen, stop } = watchActions()
        undoState()
        undoState()
        await reads.fail()
        assert.equal(liveState.value.initialLife, 109)
        assert.equal(seen.length, 0)
        assert.equal(slotLoading.value, false)
        // The queue was cleared: one press now crosses one slot, not three.
        const before = reads.reads()
        undoState()
        await reads.finish()
        await reads.finish()
        stop()
        assert.ok(reads.reads() > before, 'the press read the slot again')
        assert.equal(liveState.value.initialLife, 108)
        assert.deepEqual(
            seen.map((action) => action.kind),
            ['undo'],
        )
    })
})

test('Q1c: an edit while moves are pending emits only the edit, and the moves never land after it', async () => {
    const reads = loads()
    restore(10, 9)
    undoState()
    undoState()
    undoState()
    const { seen, stop } = watchActions()
    pushState(initialLife(109, 999), { ...liveState.value, initialLife: 999 })
    await reads.finish()
    await reads.finish()
    await reads.finish()
    stop()
    assert.equal(liveState.value.initialLife, 999)
    assert.deepEqual(
        seen.map((action) => action.kind),
        ['edit'],
    )
})

test('Q1d: slotLoading turns true after 150 ms and false when the move settles', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
        const reads = loads()
        restore(10, 9)
        assert.equal(slotLoading.value, false)
        undoState()
        assert.equal(slotLoading.value, false)
        mock.timers.tick(149)
        assert.equal(slotLoading.value, false)
        mock.timers.tick(1)
        assert.equal(slotLoading.value, true)
        await reads.finishNow()
        await reads.finishNow()
        assert.equal(liveState.value.initialLife, 108)
        assert.equal(slotLoading.value, false)
    } finally {
        mock.timers.reset()
    }
})

test('Q1d: a move that fails, or is cancelled, also ends the busy state', async () => {
    await quietly(async () => {
        mock.timers.enable({ apis: ['setTimeout'] })
        try {
            const reads = loads()
            restore(10, 9)
            undoState()
            mock.timers.tick(150)
            assert.equal(slotLoading.value, true)
            for (const { reject } of reads.waiting.splice(0)) reject(new Error('unreadable'))
            await microtasks()
            assert.equal(slotLoading.value, false)

            restore(10, 9)
            undoState()
            mock.timers.tick(150)
            assert.equal(slotLoading.value, true)
            peek.value = { source: 'test', state: base }
            assert.equal(slotLoading.value, false)
            peek.value = undefined
        } finally {
            mock.timers.reset()
        }
    })
})

// What the notice needs (DEF-2): the move reports when it lands, not when it is asked for.

test('Q1e: a queued move reports its landing, with the net direction and the last step crossed', async () => {
    const reads = loads()
    restore(10, 9)
    const crossed = undoState()
    undoState()
    const last = undoState()
    const outcome = stack.pendingMoveOutcome()
    assert.ok(outcome, 'a queued move has an outcome to wait for')
    assert.equal(stack.pendingMoveOutcome(), outcome, 'presses of one batch share it')
    assert.ok(crossed)
    await reads.finish()
    await reads.finish()
    const result = await outcome
    assert.equal(result.kind, 'landed')
    assert(result.kind === 'landed')
    assert.equal(result.direction, -1)
    assert(equalJson(result.step, last!))
    assert.equal(liveState.value.initialLife, 106)
    assert.equal(stack.pendingMoveOutcome(), undefined, 'nothing is pending after it lands')
})

test('Q1e: a move onto a loaded slot is synchronous and has no outcome to wait for', async () => {
    const reads = loads()
    restore(10, 9)
    await reads.finish() // the prefetched neighbour
    const step = undoState()
    assert.ok(step)
    assert.equal(stack.pendingMoveOutcome(), undefined)
    assert.equal(liveState.value.initialLife, 108)
})

test('Q1e: an edit, or a peek, cancels the outcome', async () => {
    const reads = loads()
    restore(10, 9)
    undoState()
    undoState()
    const edited = stack.pendingMoveOutcome()!
    pushState(initialLife(109, 999), { ...liveState.value, initialLife: 999 })
    assert.deepEqual(await edited, { kind: 'cancelled' })
    await reads.finish()
    assert.equal(liveState.value.initialLife, 999)

    restore(10, 9)
    undoState()
    const peeked = stack.pendingMoveOutcome()!
    peek.value = { source: 'test', state: base }
    assert.deepEqual(await peeked, { kind: 'cancelled' })
    peek.value = undefined
    await reads.finish()
    assert.equal(liveState.value.initialLife, 109)
})

test('Q1e: a failed load reports a failure', async () => {
    await quietly(async () => {
        const reads = loads()
        restore(10, 9)
        undoState()
        const failed = stack.pendingMoveOutcome()!
        await reads.fail()
        assert.deepEqual(await failed, { kind: 'failed' })
        assert.equal(liveState.value.initialLife, 109)
    })
})

test('Q1e: moves that net to nothing report no change', async () => {
    const reads = loads()
    restore(10, 5)
    undoState()
    redoState()
    const outcome = stack.pendingMoveOutcome()!
    await reads.finish()
    await reads.finish()
    assert.deepEqual(await outcome, { kind: 'cancelled' })
    assert.equal(liveState.value.initialLife, 105)
})
