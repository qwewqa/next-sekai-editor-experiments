import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { createAsyncEditGuard } from '../../src/editor/asyncEditGuard'
import { createOperation, type NativeOperationInput } from '../../src/history/operations'
import {
    markFileEvent,
    peek,
    pushState,
    redoState,
    replaceState,
    resetStates,
    undoState,
} from '../../src/history/stack'
import type { State } from '../../src/state'

const operation = (input: NativeOperationInput) =>
    createOperation(input, { locale: 'en', describe: () => 'Guard test' })
const first = { fixture: 'first' } as unknown as State
const second = { fixture: 'second' } as unknown as State
const init = operation({ id: 'nse.origin', data: { origin: 'new' } })
const edit = operation({
    id: 'nse.header.set',
    data: { field: 'initialLife', before: 1000, after: 999 },
})

beforeEach(() =>
    resetStates({ isDirty: false, state: first, step: { kind: 'init', operation: init } }),
)

test('async edits accept an unchanged scope and ignore Save and Export events', () => {
    const guard = createAsyncEditGuard()
    try {
        markFileEvent(
            'save',
            operation({
                id: 'nse.file.save',
                data: { file: { text: 'a.nxsp' }, delivery: 'file' },
            }),
        )
        markFileEvent(
            'export',
            operation({
                id: 'nse.file.export',
                data: { file: { text: 'a.json' }, delivery: 'download' },
            }),
        )
        assert.equal(guard.isCurrent(), true)
    } finally {
        guard.dispose()
    }
})

test('an edit, Undo and Redo permanently invalidate confirmation', () => {
    const guard = createAsyncEditGuard()
    try {
        pushState(edit, second)
        undoState()
        redoState()
        assert.equal(guard.isCurrent(), false)
    } finally {
        guard.dispose()
    }
})

// An edit that leaves the chart as it was is no step (owner, 2026-10-19), so what the user
// confirmed still holds.
test('an edit that changes nothing leaves confirmation valid', () => {
    const guard = createAsyncEditGuard()
    try {
        assert.equal(pushState(edit, first), false)
        assert.equal(guard.isCurrent(), true)
    } finally {
        guard.dispose()
    }
})

test('a temporary selection/state replacement cannot restore a stale confirmation', () => {
    const guard = createAsyncEditGuard()
    try {
        replaceState(second)
        replaceState(first)
        assert.equal(guard.isCurrent(), false)
    } finally {
        guard.dispose()
    }
})

test('same-object stack replacement invalidates confirmation through its generation', () => {
    const guard = createAsyncEditGuard()
    try {
        resetStates({ isDirty: false, state: first, step: { kind: 'init', operation: init } })
        assert.equal(guard.isCurrent(), false)
    } finally {
        guard.dispose()
    }
})

test('entering and leaving peek remains stale, including a guard opened while peeking', () => {
    const guard = createAsyncEditGuard()
    peek.value = { source: 'guard', state: first }
    const readOnly = createAsyncEditGuard()
    try {
        peek.value = undefined
        assert.equal(guard.isCurrent(), false)
        assert.equal(readOnly.isCurrent(), false)
    } finally {
        guard.dispose()
        readOnly.dispose()
    }
})

test('origin abort and disposal invalidate permanently while independent prompts stay valid', () => {
    const controller = new AbortController()
    const guard = createAsyncEditGuard(controller.signal)
    const other = createAsyncEditGuard()
    try {
        controller.abort()
        guard.dispose()
        assert.equal(guard.isCurrent(), false)
        assert.equal(other.isCurrent(), true)
        other.dispose()
        assert.equal(other.isCurrent(), false)
        const alreadyAborted = createAsyncEditGuard(controller.signal)
        assert.equal(alreadyAborted.isCurrent(), false)
        alreadyAborted.dispose()
    } finally {
        other.dispose()
    }
})

// The held-BGM attach changes the live state with no step while a dialog or a confirm is open;
// what the user typed or picked must still apply.
const bgmMeta = { hash: 'h', filename: 'a.mp3', size: 4, type: 'audio/mpeg' }
const unattached = { bgm: { offset: 0, meta: bgmMeta }, selectedEntities: [] } as unknown as State
const withAudio = (state: State, offset = state.bgm.offset) =>
    ({
        ...state,
        bgm: {
            ...state.bgm,
            offset,
            buffer: {} as AudioBuffer,
            source: new ArrayBuffer(4),
        },
    }) as State

test('attaching the named audio leaves confirmation valid; any other change does not', () => {
    resetStates({ isDirty: false, state: unattached, step: { kind: 'init', operation: init } })
    const guard = createAsyncEditGuard()
    const other = createAsyncEditGuard()
    try {
        replaceState(withAudio(unattached))
        assert.equal(guard.isCurrent(), true)
        // An offset changed along with the audio is not an attach.
        replaceState(withAudio(unattached, 5))
        assert.equal(guard.isCurrent(), false)
        assert.equal(other.isCurrent(), false)
    } finally {
        guard.dispose()
        other.dispose()
    }
})

test('audio attached to another hash invalidates confirmation', () => {
    resetStates({ isDirty: false, state: unattached, step: { kind: 'init', operation: init } })
    const guard = createAsyncEditGuard()
    try {
        const attached = withAudio(unattached)
        replaceState({
            ...attached,
            bgm: { ...attached.bgm, meta: { ...bgmMeta, hash: 'other' } },
        })
        assert.equal(guard.isCurrent(), false)
    } finally {
        guard.dispose()
    }
})
