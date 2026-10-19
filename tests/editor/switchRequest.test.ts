import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { createSwitchRequest } from '../../src/editor/switchRequest'
import { onHistoryAction } from '../../src/history/actions'
import { leavePeek, peekEntry, setPeekSource } from '../../src/history/peek'
import { createSessionDescriptor, session } from '../../src/history/session'
import {
    liveState,
    markFileEvent,
    pushState,
    redoState,
    replaceState,
    resetStates,
    restoreStates,
    setSlotLoader,
    undoState,
} from '../../src/history/stack'
import { editStep, initialLife, initialStep, nativeOperation } from '../helpers/historySteps'
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
            request.publish(
                { state: before, sessionId: session.value.sessionId, reset: true },
                () => assert.fail('stale publication'),
            ),
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
    const publish = (owner: ReturnType<typeof createSwitchRequest>, after = () => {}) => {
        const descriptor = createSessionDescriptor()
        const state = stateOf(goldenChart())
        return owner.publish({ state, sessionId: descriptor.sessionId, reset: true }, () => {
            session.value = descriptor
            resetStates({ state, step: initialStep(), isDirty: false })
            after()
        })
    }
    assert.equal(publish(request), true)
    let newer: ReturnType<typeof createSwitchRequest> | undefined
    assert.equal(
        publish(request, () => {
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
        assert.equal(publish(edited), false)
    } finally {
        stop()
        edited.dispose()
    }
    const replaced = createSwitchRequest()
    assert.equal(
        publish(replaced, () => {
            const before = liveState.value
            replaceState({ ...before, initialLife: before.initialLife + 1 })
            replaceState(before)
        }),
        false,
    )
    replaced.dispose()
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

test('an initiating pending peek can settle, but a later peek intent revokes the switch', async () => {
    let finish!: (value: { state: typeof liveState.value; time: number }) => void
    const pending = new Promise<{ state: typeof liveState.value; time: number }>((resolve) => {
        finish = resolve
    })
    setPeekSource({ load: () => pending, sameSnapshot: (a, b) => a === b })
    const loading = peekEntry('test:1')
    const request = createSwitchRequest()
    try {
        finish({ state: liveState.value, time: 1 })
        await loading
        assert.equal(request.isCurrent(), true)
        const newer = peekEntry('test:1')
        assert.equal(request.isCurrent(), false)
        leavePeek()
        await newer
    } finally {
        request.dispose()
        leavePeek()
        setPeekSource(undefined)
    }
})

test('accepted unloaded Undo invalidates immediately; a no-op Undo does not', async () => {
    const harmless = createSwitchRequest()
    undoState()
    assert.equal(harmless.isCurrent(), true)
    harmless.dispose()
    const before = liveState.value
    let finish!: (state: typeof before) => void
    const pending = new Promise<typeof before>((resolve) => {
        finish = resolve
    })
    setSlotLoader(() => pending)
    const after = { ...before, initialLife: before.initialLife + 1 }
    restoreStates(
        [
            { step: initialStep(), snapshot: new Uint8Array(32), isDirty: false },
            { step: editStep(initialLife(before.initialLife, after.initialLife)), isDirty: true },
        ],
        1,
        after,
    )
    const request = createSwitchRequest()
    try {
        const moving = undoState()
        assert.equal(liveState.value, after)
        assert.equal(request.isCurrent(), false)
        finish(before)
        await moving
        assert.equal(request.isCurrent(), false)
    } finally {
        request.dispose()
        setSlotLoader(undefined)
    }
})

test('a new peek from a reset hook is never mistaken for leaving the initial peek', async () => {
    setPeekSource({
        load: async () => ({ state: liveState.value, time: 1 }),
        sameSnapshot: (a, b) => a === b,
    })
    const request = createSwitchRequest()
    const descriptor = createSessionDescriptor()
    const state = stateOf(goldenChart())
    let loading: Promise<void> | undefined
    try {
        assert.equal(
            request.publish({ state, sessionId: descriptor.sessionId, reset: true }, () => {
                session.value = descriptor
                resetStates({ state, step: initialStep(), isDirty: false })
                loading = peekEntry('hook:1')
            }),
            false,
        )
        leavePeek()
        await loading
    } finally {
        request.dispose()
        setPeekSource(undefined)
    }
})
