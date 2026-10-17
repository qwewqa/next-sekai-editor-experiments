import assert from 'node:assert/strict'
import test from 'node:test'
import { onHistoryAction, type HistoryAction } from '../../../src/history/actions'
import { pushState, redoState, resetStates, undoState } from '../../../src/history/stack'
import { goldenChart, stateOf } from '../records/charts'

// The undo stack's actions, which the flush turns into entries (§1.3.8): a reset starts a
// session; edits, undos and redos follow, each with the state it leaves on screen.

test('the undo stack reports resets, edits, undos and redos, and replays those since the last reset once', () => {
    const a = stateOf(goldenChart())
    const b = { ...a, initialLife: 900 }
    const c = { ...a, initialLife: 800 }
    resetStates({ isDirty: false, name: () => 'Initialize', state: a })
    pushState(() => 'B', b)

    const seen: HistoryAction[] = []
    const stop = onHistoryAction((action) => seen.push(action), { replay: true })
    assert.deepEqual(
        seen.map(({ kind, state }) => [kind, state?.initialLife]),
        [
            ['reset', a.initialLife],
            ['edit', 900],
        ],
    )
    assert.equal(seen[0]?.kind === 'reset' && seen[0].origin, 'new')

    pushState(() => 'C', c)
    undoState()
    redoState()
    resetStates({ isDirty: true, name: () => 'Initialize', state: a }, 'import')
    stop()
    assert.deepEqual(
        seen.slice(2).map((action) => [action.kind, action.name(), action.state?.initialLife]),
        [
            ['edit', 'C', 800],
            ['undo', 'C', 900],
            ['redo', 'C', 800],
            ['reset', 'Initialize', a.initialLife],
        ],
    )
    assert.equal(seen.at(-1)?.kind === 'reset' && seen.at(-1)?.isDirty, true)

    // A second replay has nothing: the early actions went to the first listener.
    const late: HistoryAction[] = []
    onHistoryAction((action) => late.push(action), { replay: true })()
    assert.deepEqual(late, [])
})
