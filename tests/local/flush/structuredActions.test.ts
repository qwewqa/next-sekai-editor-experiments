import assert from 'node:assert/strict'
import test from 'node:test'
import { EARLY_LIMIT, onHistoryAction, type HistoryAction } from '../../../src/history/actions'
import { captureStep, equalJson, type JsonValue } from '../../../src/history/operations'
import {
    headStep,
    liveState,
    pushState,
    redoState,
    replaceState,
    resetStates,
    restoreStates,
    setSlotLoader,
    undoState,
} from '../../../src/history/stack'
import {
    futureFixtureOperation,
    initialLife,
    initialStep,
    nativeOperation,
    restoreStep,
} from '../../helpers/historySteps'
import { goldenChart, stateOf } from '../records/charts'

test('early compaction preserves Restore and complete crossed steps', () => {
    const a = stateOf(goldenChart())
    const b = { ...a, initialLife: 900 }
    const restored = { ...a, initialLife: 800 }
    resetStates({ isDirty: false, step: initialStep(), state: a })
    pushState(initialLife(a.initialLife, 900), b)
    const operation = nativeOperation(
        { id: 'nse.restore', data: { targetTime: 123 } },
        'Restored 123',
    )
    pushState(operation, restored, 'restore')
    for (let i = 0; i < EARLY_LIMIT + 1; i++) {
        const crossed = undoState()
        assert.equal(crossed?.kind, 'restore')
        assert(equalJson(crossed!.operation, operation as unknown as JsonValue))
        redoState()
    }
    const seen: HistoryAction[] = []
    const stop = onHistoryAction((action) => seen.push(action), { replay: true })
    stop()
    assert(seen.length < EARLY_LIMIT + 4)
    const pushes = seen.filter((action) => action.kind === 'edit' || action.kind === 'restore')
    assert.deepEqual(
        pushes.map((action) => action.kind),
        ['edit', 'restore'],
    )
    const restoredAction = pushes[1]
    assert(restoredAction && 'step' in restoredAction)
    assert.equal(restoredAction.step.kind, 'restore')
    for (const action of seen) {
        if (action.kind !== 'undo' && action.kind !== 'redo') continue
        assert.equal(action.step.kind, 'restore')
        assert(equalJson(action.step.operation, operation as unknown as JsonValue))
    }
})

test('restored opaque step survives selection replacement and crossed Undo/Redo', async () => {
    const state = stateOf(goldenChart())
    const opaque = futureFixtureOperation(
        'newRestore',
        { nested: { future: ['x', 9] } },
        '<Future> {0}',
    )
    const step = captureStep({ ...restoreStep(22), operation: opaque })
    restoreStates(
        [
            { step: initialStep(), snapshot: new Uint8Array(16), isDirty: false },
            { step, isDirty: true },
        ],
        1,
        state,
    )
    replaceState({ ...state, selectedEntities: [] })
    assert(equalJson(headStep.value!.operation, opaque))
    const before = liveState.value
    assert.throws(() =>
        restoreStates(
            [{ step: { kind: 'undo', operation: null } as never, isDirty: false }],
            0,
            state,
        ),
    )
    assert.equal(liveState.value, before)
    setSlotLoader(async () => state)
    const crossed = undoState()
    assert.equal(crossed?.kind, 'restore')
    assert(equalJson(crossed!.operation, opaque))
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(redoState(), crossed)
    setSlotLoader(undefined)
})
