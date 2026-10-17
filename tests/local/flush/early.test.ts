import assert from 'node:assert/strict'
import test from 'node:test'
import { EARLY_LIMIT, onHistoryAction, type HistoryAction } from '../../../src/history/actions'
import { pushState, resetStates } from '../../../src/history/stack'
import { goldenChart, stateOf } from '../records/charts'

// Actions before storing starts are kept for it, but boundedly: a start that never comes mustn't
// hold every state of the page's life.

test('early actions keep the last reset and the newest edits, at most EARLY_LIMIT', () => {
    const a = stateOf(goldenChart())
    resetStates({ isDirty: false, name: () => 'Initialize', state: a })
    for (let i = 0; i < EARLY_LIMIT + 50; i++)
        pushState(() => `Edit ${i}`, { ...a, initialLife: i })
    const seen: HistoryAction[] = []
    onHistoryAction((action) => seen.push(action), { replay: true })()
    assert.equal(seen.length, EARLY_LIMIT)
    assert.equal(seen[0]?.kind, 'reset')
    assert.equal(seen[1]?.state.initialLife, 51)
    assert.equal(seen.at(-1)?.state.initialLife, EARLY_LIMIT + 49)
})
