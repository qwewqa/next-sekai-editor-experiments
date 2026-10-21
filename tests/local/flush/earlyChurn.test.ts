import assert from 'node:assert/strict'
import test from 'node:test'
import { EARLY_LIMIT, onHistoryAction, type HistoryAction } from '../../../src/history/actions'
import { captureEntryDescription } from '../../../src/history/operations'
import { pushState, redoState, resetStates, undoState } from '../../../src/history/stack'
import { replay } from '../../../src/local/timeline'
import type { State } from '../../../src/state'
import { initialLife, initialStep } from '../../helpers/historySteps'
import '../../helpers/lockChecks'
import { goldenChart, stateOf } from '../records/charts'

// Early actions on a short stack churned by undo and redo: past the bound they're cut to the
// actions that give the stack, and the live actions after storing starts still follow them.
// (Its own file: the early buffer is taken once per page.)

/** Replays actions as the flusher's entries, each state standing for its snapshot. */
const stackOf = (actions: readonly HistoryAction[]) => {
    const ids = new Map<State, number>()
    const entries = actions.map((action, seq) => {
        const state = action.state
        if (!state) throw new Error('An action with no state')
        if (!ids.has(state)) ids.set(state, ids.size)
        const snapshot = new Uint8Array(16)
        new DataView(snapshot.buffer).setUint32(0, ids.get(state) ?? 0)
        return {
            seq: seq + 1,
            ...captureEntryDescription(
                action.kind === 'reset'
                    ? { kind: 'init', operation: action.step.operation }
                    : action,
            ),
            snapshot,
        }
    })
    const { slots, index } = replay(entries)
    const states = [...ids.keys()]
    const idOf = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset).getUint32(0)
    return { lives: slots.map((slot) => states[idOf(slot.snapshot)]?.initialLife), index }
}

test('undo and redo churn past the bound is cut to the stack, and later actions follow it', () => {
    const a = stateOf(goldenChart())
    const at = (life: number): State => ({ ...a, initialLife: life })
    // Counts what's emitted without taking the early buffer.
    let emitted = 0
    const counting = onHistoryAction(() => emitted++)
    resetStates({ isDirty: false, step: initialStep(), state: at(0) })
    for (let i = 1; i <= 10; i++) pushState(initialLife(i - 1, i), at(i))
    for (let i = 0; i < 300; i++) {
        undoState()
        undoState()
        redoState()
    }
    counting()
    const seen: HistoryAction[] = []
    const stop = onHistoryAction((action) => seen.push(action), { replay: true })
    // A cut happened: far fewer actions than were emitted, within the bound.
    assert.ok(seen.length < emitted, `${seen.length} of ${emitted}`)
    assert.ok(seen.length <= EARLY_LIMIT + 11)
    assert.equal(seen[0]?.kind, 'reset')
    // Their replay is the live stack, at its index.
    const live = stackOf(seen)
    assert.deepEqual(live.lives, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    assert.equal(live.index, 1)
    // Live actions after storing starts follow: an undo, then an edit dropping the redo end.
    undoState()
    pushState(initialLife(0, 99), at(99))
    stop()
    const after = stackOf(seen)
    assert.deepEqual(after.lives, [...live.lives.slice(0, live.index), 99])
    assert.equal(after.index, live.index)
})
