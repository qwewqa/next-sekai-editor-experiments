import assert from 'node:assert/strict'
import test from 'node:test'
import { EARLY_LIMIT, onHistoryAction, type HistoryAction } from '../../../src/history/actions'
import { captureEntryDescription } from '../../../src/history/operations'
import { pushState, resetStates, undoState } from '../../../src/history/stack'
import { replay } from '../../../src/local/timeline'
import type { State } from '../../../src/state'
import { initialLife, initialStep } from '../../helpers/historySteps'
import '../../helpers/lockChecks'
import { goldenChart, stateOf } from '../records/charts'

// Actions before storing starts are kept for it, but boundedly: a start that never comes mustn't
// hold every state of the page's life. Past the bound they're cut down to the actions that give
// the stack as it is, never with one dropped from the middle, so storing follows what comes next.

/** Replays actions as the flusher's entries: each state stands for its snapshot. */
const stackOf = (actions: readonly HistoryAction[]) => {
    const ids = new Map<State, number>()
    const snapshot = (state: State | undefined) => {
        if (!state) throw new Error('An action with no state')
        if (!ids.has(state)) ids.set(state, ids.size)
        const bytes = new Uint8Array(16)
        new DataView(bytes.buffer).setUint32(0, ids.get(state) ?? 0)
        return bytes
    }
    const entries = actions.map((action, seq) => ({
        seq: seq + 1,
        ...captureEntryDescription(
            action.kind === 'reset' ? { kind: 'init', operation: action.step.operation } : action,
        ),
        snapshot: snapshot(action.state),
    }))
    const { slots, index } = replay(entries)
    const states = [...ids.keys()]
    const idOf = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset).getUint32(0)
    return { lives: slots.map((slot) => states[idOf(slot.snapshot)]?.initialLife), index }
}

test('early actions past the limit are cut to the stack they give, so later actions follow', () => {
    const a = stateOf(goldenChart())
    const at = (life: number): State => ({ ...a, initialLife: life })
    resetStates({ isDirty: false, step: initialStep(), state: at(0) })
    // What the live stack holds, as the editor's own moves leave it.
    const live = [0]
    let index = 0
    const push = (life: number) => {
        pushState(initialLife(live[index]!, life), at(life))
        live.length = index + 1
        live.push(life)
        index++
    }
    const undo = () => {
        undoState()
        index--
    }
    for (let i = 1; i <= EARLY_LIMIT + 50; i++) push(i)
    for (let i = 0; i < 100; i++) undo()
    // A redo branch dropped: its states needn't be kept.
    for (let i = 0; i < EARLY_LIMIT; i++) push(1000 + i)
    for (let i = 0; i < 20; i++) undo()

    const seen: HistoryAction[] = []
    onHistoryAction((action) => seen.push(action), { replay: true })()
    assert.ok(seen.length <= EARLY_LIMIT + live.length, `${seen.length}`)
    assert.equal(seen[0]?.kind, 'reset')
    // Their replay is the live stack, at its index.
    assert.deepEqual(stackOf(seen), { lives: live, index })
    // Of the states a dropped redo branch held, at most EARLY_LIMIT are kept.
    const onStack = new Set(live)
    const held = new Set(seen.map((action) => action.state?.initialLife))
    assert.ok([...held].filter((life) => !onStack.has(life ?? -1)).length <= EARLY_LIMIT)
})
