import assert from 'node:assert/strict'
import test from 'node:test'
import { onHistoryAction, type HistoryAction } from '../../../src/history/actions'
import { pushState, redoState, resetStates, undoState } from '../../../src/history/stack'
import { initialLife, initialStep } from '../../helpers/historySteps'
import '../../helpers/lockChecks'
import { goldenChart, stateOf } from '../records/charts'

// The undo stack's actions, which the flush turns into entries (§1.3.8): a reset starts a
// session; edits, undos and redos follow, each with the state it leaves on screen.

test('the undo stack reports resets, edits, undos and redos, and replays those since the last reset once', () => {
    const a = stateOf(goldenChart())
    const b = { ...a, initialLife: 900 }
    const c = { ...a, initialLife: 800 }
    resetStates({ isDirty: false, step: initialStep(), state: a })
    pushState(initialLife(a.initialLife, 900), b)

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

    pushState(initialLife(900, 800), c)
    undoState()
    redoState()
    resetStates({ isDirty: true, step: initialStep(), state: a }, 'import')
    stop()
    assert.deepEqual(
        seen.slice(2).map((action) => [action.kind, action.state?.initialLife]),
        [
            ['edit', 800],
            ['undo', 900],
            ['redo', 800],
            ['reset', a.initialLife],
        ],
    )
    for (const action of seen.slice(2, 5)) {
        assert('step' in action)
        assert.deepEqual(action.step.operation, initialLife(900, 800))
    }
    assert.equal(seen.at(-1)?.kind === 'reset' && seen.at(-1)?.isDirty, true)

    // A second replay has nothing: the early actions went to the first listener.
    const late: HistoryAction[] = []
    onHistoryAction((action) => late.push(action), { replay: true })()
    assert.deepEqual(late, [])
})
