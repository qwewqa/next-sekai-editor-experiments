import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { createSwitchRequest } from '../../src/editor/switchRequest'
import { onHistoryAction } from '../../src/history/actions'
import { setPeekSource } from '../../src/history/peek'
import { createSessionDescriptor, session } from '../../src/history/session'
import {
    liveState,
    markFileEvent,
    pushState,
    redoState,
    replaceState,
    resetStates,
    undoState,
} from '../../src/history/stack'
import { initialLife, initialStep, nativeOperation } from '../helpers/historySteps'
import { goldenChart, stateOf } from '../local/records/charts'

const reset = () =>
    resetStates({ state: stateOf(goldenChart()), step: initialStep(), isDirty: false })
beforeEach(() => {
    reset()
    session.value = createSessionDescriptor()
    setPeekSource(undefined)
})

test('selection, same-media cache and file bookkeeping preserve switch permission', () => {
    const request = createSwitchRequest()
    try {
        replaceState({ ...liveState.value, selectedEntities: [] })
        replaceState({
            ...liveState.value,
            bgm: { ...liveState.value.bgm, source: new ArrayBuffer(0) },
        })
        session.value = {
            ...session.value,
            name: 'Saved name',
            file: { name: 'a.nxsp', event: 'saved' },
        }
        markFileEvent(
            'save',
            nativeOperation(
                { id: 'nse.file.save', data: { file: { text: 'a.nxsp' }, delivery: 'file' } },
                'Saved',
            ),
        )
        assert.equal(request.isCurrent(), true)
    } finally {
        request.dispose()
    }
})

test('edit and Undo/Redo ABA permanently revoke a pending switch', () => {
    const request = createSwitchRequest()
    try {
        const before = liveState.value
        pushState(initialLife(before.initialLife, before.initialLife + 1), {
            ...before,
            initialLife: before.initialLife + 1,
        })
        undoState()
        redoState()
        undoState()
        assert.equal(liveState.value, before)
        assert.equal(
            request.publish(() => assert.fail('stale publication')),
            false,
        )
    } finally {
        request.dispose()
    }
})

test('content replacement ABA and source replacement invalidate without a history event', () => {
    const before = liveState.value
    const request = createSwitchRequest()
    replaceState({ ...before, initialLife: before.initialLife + 1 })
    replaceState(before)
    assert.equal(request.isCurrent(), false)
    request.dispose()
    const source = createSwitchRequest()
    setPeekSource(undefined)
    assert.equal(source.isCurrent(), false)
    source.dispose()
})

test('the newest issued request wins even if it is cancelled', () => {
    const old = createSwitchRequest()
    const newer = createSwitchRequest()
    newer.cancel()
    assert.equal(old.isCurrent(), false)
    assert.equal(newer.isCurrent(), false)
    old.dispose()
    newer.dispose()
})

test('own synchronous publication rebases, but a reentrant newer request or edit never does', () => {
    const request = createSwitchRequest()
    assert.equal(
        request.publish(() => {
            reset()
            session.value = createSessionDescriptor()
        }),
        true,
    )
    let newer: ReturnType<typeof createSwitchRequest> | undefined
    assert.equal(
        request.publish(() => {
            reset()
            newer = createSwitchRequest()
        }),
        false,
    )
    assert.equal(newer?.isCurrent(), true)
    request.dispose()
    newer?.dispose()

    const edited = createSwitchRequest()
    const stop = onHistoryAction(({ kind }) => {
        if (kind !== 'reset') return
        const before = liveState.value
        pushState(initialLife(before.initialLife, before.initialLife + 1), {
            ...before,
            initialLife: before.initialLife + 1,
        })
    })
    try {
        assert.equal(edited.publish(reset), false)
    } finally {
        stop()
        edited.dispose()
    }
})

test('normal modal unmount differs from active-task cancellation and retained cleanup settles', async () => {
    const request = createSwitchRequest()
    const normal = new AbortController()
    request.observeAbort(normal.signal)()
    normal.abort()
    assert.equal(request.isCurrent(), true)
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
        finish = resolve
    })
    request.retainUntil(pending)
    request.dispose()
    assert.equal(request.isCurrent(), true)
    const cancelled = new AbortController()
    const stop = request.observeAbort(cancelled.signal)
    cancelled.abort()
    assert.equal(request.isCurrent(), false)
    stop()
    finish()
    await pending
    assert.equal(request.isCurrent(), false)
})
