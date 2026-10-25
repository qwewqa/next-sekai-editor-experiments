import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'
import { setImmediate as settleTasks } from 'node:timers/promises'
import type { Command } from '../../src/editor/commands'
import { runCommand } from '../../src/editor/commands/runCommand'
import { onHistoryAction, type HistoryAction } from '../../src/history/actions'
import { playbackBgm } from '../../src/history/bgm'
import {
    displayedPeekKey,
    entryKey,
    isPeeking,
    leavePeek,
    onPeekLeft,
    onPeekRefused,
    onPeekStart,
    parseEntryKey,
    PEEK_DEBOUNCE_MS,
    PEEK_LRU,
    PEEK_READY_MAX_MS,
    peekedKey,
    peekEntry,
    PeekError,
    peekRequestGeneration,
    peekSourceGeneration,
    resetPeekForTests,
    restoreEntry,
    runPendingPeek,
    setPeekEffects,
    setPeekSource,
    type EntryKey,
    type PeekedEntry,
} from '../../src/history/peek'
import {
    cancelPendingMoves,
    liveState,
    markFileEvent,
    pushState,
    redoState,
    replaceState,
    resetStates,
    restoreStates,
    setSlotLoader,
    stackMoveRequestGeneration,
    state,
    undoState,
} from '../../src/history/stack'
import type { State } from '../../src/state'
import { editStep, initialLife, initialStep, nativeOperation } from '../helpers/historySteps'

// Peek's core in Node: the override, debounced requests, failures, leaving,
// Restore, the state cache and runCommand's gate with the refusal hook.

type Fake = State & { name: string }

const fake = (name: string, offset = 0, extra: Partial<State> = {}) =>
    ({
        name,
        bgm: { offset },
        selectedEntities: [],
        ...extra,
    }) as unknown as Fake

const nameOf = (value: State) => (value as Fake).name

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const deferred = <T>() => {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((done, fail) => {
        resolve = done
        reject = fail
    })
    return { promise, resolve, reject }
}

/** A source holding entries by key, counting loads; `fail` keys reject as damaged. */
const source = (entries: Record<string, PeekedEntry>, fail: string[] = []) => {
    const loads: string[] = []
    setPeekSource({
        load: async (key) => {
            loads.push(key)
            await Promise.resolve()
            if (fail.includes(key)) throw new PeekError('damaged')
            const entry = entries[key]
            if (!entry) throw new PeekError('missing')
            return entry
        },
        sameSnapshot: (a, b) => nameOf(a) === nameOf(b) && a.bgm.offset === b.bgm.offset,
    })
    return loads
}

const notices: string[] = []
setPeekEffects({
    restoredOperation: (time) =>
        nativeOperation({ id: 'nse.restore', data: { targetTime: time } }, `Restored to ${time}`),
    restored: (time) => notices.push(`restored ${time}`),
    alreadyMatches: () => notices.push('matches'),
})

const key = (seq: number): EntryKey => entryKey('session', seq)

beforeEach(async () => {
    resetPeekForTests()
    setSlotLoader(undefined)
    notices.length = 0
    // Clears the debounce window of an earlier test.
    await wait(110)
    resetStates({ isDirty: false, step: initialStep(), state: fake('live') })
})

test('source replacement invalidates metadata at Now, including same and absent sources', () => {
    const start = peekSourceGeneration.value
    const next = {
        load: async () => ({ state: fake('entry'), time: 1 }),
        sameSnapshot: () => false,
    }
    setPeekSource(next)
    setPeekSource(next)
    setPeekSource(undefined)
    setPeekSource(undefined)
    assert.equal(peekSourceGeneration.value, start + 4)
    assert.equal(isPeeking.value, false)
    assert.equal(nameOf(liveState.value), 'live')
})

test('entry keys name a session and a seq', () => {
    assert.equal(entryKey('a-b', 12), 'a-b:12')
    assert.deepEqual(parseEntryKey('a-b:12'), { sessionId: 'a-b', seq: 12 })
})

test('peeking starts at once, shows the entry, and writers keep the live state', async () => {
    const live = liveState.value
    source({ [key(1)]: { state: fake('old'), time: 1000 } })
    const shown = peekEntry(key(1))
    assert.equal(isPeeking.value, true)
    assert.equal(peekedKey.value, key(1))
    // Until it loads, what was shown stays, read-only.
    assert.equal(nameOf(state.value), 'live')
    assert.equal(displayedPeekKey.value, undefined)
    await shown
    assert.equal(nameOf(state.value), 'old')
    assert.equal(displayedPeekKey.value, key(1))
    assert.equal(liveState.value, live)
    leavePeek()
    assert.equal(isPeeking.value, false)
    assert.equal(peekedKey.value, undefined)
    assert.equal(displayedPeekKey.value, undefined)
    assert.equal(state.value, live)
})

test('a peek starts with no selection and the live audio', async () => {
    const buffer = {} as AudioBuffer
    resetStates({
        isDirty: false,
        step: initialStep(),
        state: fake('live', 0, { bgm: { offset: 0, buffer } }),
    })
    const selected = [{}] as State['selectedEntities']
    source({ [key(1)]: { state: fake('old', 2, { selectedEntities: selected }), time: 1 } })
    await peekEntry(key(1))
    assert.deepEqual(state.value.selectedEntities, [])
    assert.equal(state.value.bgm.buffer, buffer)
    assert.equal(state.value.bgm.offset, 2)
})

test('a session’s peek plays without the live audio, while it loads and once shown', async () => {
    const buffer = {} as AudioBuffer
    const waveform = {} as State['bgm']['waveform']
    resetStates({
        isDirty: false,
        step: initialStep(),
        state: fake('live', 0, { bgm: { offset: 0, buffer, waveform } }),
    })
    source({ [key(1)]: { state: fake('old', 2), time: 1 } })
    const loading = peekEntry(key(1), { audio: 'none' })
    assert.equal(state.value.bgm.buffer, undefined)
    assert.equal(state.value.bgm.waveform, undefined)
    await loading
    assert.equal(state.value.bgm.buffer, undefined)
    assert.equal(state.value.bgm.waveform, undefined)
    assert.equal(state.value.bgm.offset, 2)
    // The live state keeps its audio, and a step’s peek still shows with it.
    assert.equal(liveState.value.bgm.buffer, buffer)
    await peekEntry(key(1))
    assert.equal(state.value.bgm.buffer, buffer)
    assert.equal(state.value.bgm.waveform, waveform)
})

const heldEntry = () => {
    const read = deferred<PeekedEntry>()
    const loads: EntryKey[] = []
    setPeekSource({
        load: (entry) => {
            loads.push(entry)
            return entry === key(1)
                ? read.promise
                : Promise.resolve({ state: fake('newer'), time: 2 })
        },
        sameSnapshot: () => false,
    })
    return { ...read, loads }
}

for (const outcome of ['success', 'failure'] as const)
    test(`a newer Restore owns completion when the older read ends in ${outcome}`, async () => {
        const held = heldEntry()
        const failures: unknown[] = []
        const older = restoreEntry(key(1), (error) => failures.push(error))
        assert.deepEqual(held.loads, [key(1)])
        await restoreEntry(key(2))
        if (outcome === 'success') held.resolve({ state: fake('older'), time: 1 })
        else held.reject(new PeekError('damaged'))
        await older
        assert.equal(nameOf(liveState.value), 'newer')
        assert.deepEqual(notices, ['restored 2'])
        assert.deepEqual(failures, [])
    })

for (const outcome of ['success', 'failure'] as const)
    test(`same-key Restores share the read but only the latest handles ${outcome}`, async () => {
        const held = heldEntry()
        const failures: string[] = []
        const older = restoreEntry(key(1), () => failures.push('older'))
        const newer = restoreEntry(key(1), () => failures.push('newer'))
        assert.deepEqual(held.loads, [key(1)])
        if (outcome === 'success') held.resolve({ state: fake('restored'), time: 1 })
        else held.reject(new PeekError('damaged'))
        await Promise.all([older, newer])
        assert.deepEqual(notices, outcome === 'success' ? ['restored 1'] : [])
        assert.deepEqual(failures, outcome === 'failure' ? ['newer'] : [])
        assert.equal(nameOf(liveState.value), outcome === 'success' ? 'restored' : 'live')
    })

test('obsolete Restore cleanup cannot dispose a newer pending owner', async () => {
    const first = deferred<PeekedEntry>()
    const second = deferred<PeekedEntry>()
    const loads: EntryKey[] = []
    setPeekSource({
        load: (entry) => {
            loads.push(entry)
            return entry === key(1) ? first.promise : second.promise
        },
        sameSnapshot: () => false,
    })
    const older = restoreEntry(key(1))
    const newer = restoreEntry(key(2))
    assert.deepEqual(loads, [key(1), key(2)])
    first.resolve({ state: fake('older'), time: 1 })
    await older
    const live = liveState.value
    pushState(initialLife(0, 1), { ...live, initialLife: 1 })
    undoState()
    second.resolve({ state: fake('newer'), time: 2 })
    await newer
    assert.equal(liveState.value, live)
    assert.deepEqual(notices, [])
})

for (const change of ['edit and Undo', 'content replacement and return'] as const)
    test(`pending Restore stays stale after ${change}`, async () => {
        const held = heldEntry()
        const restoring = restoreEntry(key(1))
        assert.deepEqual(held.loads, [key(1)])
        const live = liveState.value
        if (change === 'content replacement and return') {
            replaceState({ ...live, initialLife: 100 })
            replaceState(live)
        } else {
            pushState(initialLife(0, 1), { ...live, initialLife: 1 })
            undoState()
        }
        held.resolve({ state: fake('obsolete'), time: 1 })
        await restoring
        assert.equal(liveState.value, live)
        assert.deepEqual(notices, [])
    })

// An edit that leaves the chart as it was is no step: nothing changed under
// the pending Restore, so it still lands.
test('pending Restore still lands after an edit that changes nothing', async () => {
    const held = heldEntry()
    const restoring = restoreEntry(key(1))
    assert.deepEqual(held.loads, [key(1)])
    const live = liveState.value
    assert.equal(pushState(initialLife(0, 1), live), false)
    held.resolve({ state: fake('obsolete'), time: 1 })
    await restoring
    assert.equal(nameOf(liveState.value), 'obsolete')
    assert.deepEqual(notices, ['restored 1'])
})

for (const change of ['same-key peek', 'different-key peek', 'leave'] as const)
    test(`pending Restore cannot supersede a newer ${change}`, async () => {
        const held = heldEntry()
        const restoring = restoreEntry(key(1))
        assert.deepEqual(held.loads, [key(1)])
        const peeking =
            change === 'leave' ? undefined : peekEntry(key(change === 'same-key peek' ? 1 : 2))
        if (change === 'leave') leavePeek()
        held.resolve({ state: fake('old'), time: 1 })
        await Promise.all([restoring, peeking])
        assert.equal(nameOf(liveState.value), 'live')
        assert.equal(
            peekedKey.value,
            change === 'leave' ? undefined : key(change === 'same-key peek' ? 1 : 2),
        )
        assert.deepEqual(notices, [])
    })

test('initiating peek completion is allowed and does not advance request generation', async () => {
    const held = heldEntry()
    const peeking = peekEntry(key(1))
    const request = peekRequestGeneration.value
    const restoring = restoreEntry(key(1))
    assert.deepEqual(held.loads, [key(1)])
    held.resolve({ state: fake('old'), time: 1 })
    await Promise.all([peeking, restoring])
    assert.equal(
        peekRequestGeneration.value,
        request + 1,
        'only the successful Restore leave advances',
    )
    assert.equal(nameOf(liveState.value), 'old')
    assert.deepEqual(notices, ['restored 1'])
})

test('selection, file events and audio cache completion keep a pending Restore valid', async () => {
    const held = heldEntry()
    const restoring = restoreEntry(key(1))
    assert.deepEqual(held.loads, [key(1)])
    const buffer = {} as AudioBuffer
    replaceState({
        ...liveState.value,
        selectedEntities: [{}] as State['selectedEntities'],
        bgm: { ...liveState.value.bgm, buffer },
    })
    for (const kind of ['save', 'export'] as const)
        markFileEvent(
            kind,
            nativeOperation(
                {
                    id: kind === 'save' ? 'nse.file.save' : 'nse.file.export',
                    data: { file: { text: 'chart.nxsp' }, delivery: 'file' },
                },
                kind,
            ),
        )
    held.resolve({ state: fake('old'), time: 1 })
    await restoring
    assert.equal(nameOf(liveState.value), 'old')
    assert.equal(liveState.value.bgm.buffer, buffer)
    assert.deepEqual(liveState.value.selectedEntities, [])
    assert.deepEqual(notices, ['restored 1'])
})

const lazyStack = () => {
    const read = deferred<State>()
    let loads = 0
    setSlotLoader(() => {
        loads++
        return read.promise
    })
    restoreStates(
        [
            { snapshot: new Uint8Array([1]), step: initialStep(), isDirty: false },
            { step: editStep(initialLife(0, 1)), isDirty: true },
        ],
        1,
        fake('live'),
    )
    return { ...read, loads: () => loads }
}

for (const returnToStart of [false, true])
    test(`new lazy Undo invalidates Restore before settlement${returnToStart ? ', even after queued Redo' : ''}`, async () => {
        const slot = lazyStack()
        const held = heldEntry()
        const restoring = restoreEntry(key(1))
        assert.deepEqual(held.loads, [key(1)])
        const request = stackMoveRequestGeneration.value
        undoState()
        assert.equal(slot.loads(), 1)
        if (returnToStart) redoState()
        assert.equal(stackMoveRequestGeneration.value, request + (returnToStart ? 2 : 1))
        held.resolve({ state: fake('obsolete'), time: 1 })
        await restoring
        assert.equal(nameOf(liveState.value), 'live')
        assert.deepEqual(notices, [])
        slot.resolve(fake('undone'))
        await settleTasks()
        assert.equal(nameOf(liveState.value), returnToStart ? 'live' : 'undone')
    })

for (const order of ['Restore first', 'Undo first', 'Undo cancelled', 'Undo failed'] as const)
    test(`an older lazy Undo is initial context: ${order}`, async (t) => {
        const slot = lazyStack()
        undoState()
        assert.equal(slot.loads(), 1)
        const request = stackMoveRequestGeneration.value
        const held = heldEntry()
        const restoring = restoreEntry(key(1))
        assert.deepEqual(held.loads, [key(1)])
        if (order === 'Undo first') {
            slot.resolve(fake('undone'))
            await settleTasks()
        } else if (order === 'Undo cancelled') cancelPendingMoves()
        else if (order === 'Undo failed') {
            t.mock.method(console, 'error', () => undefined)
            slot.reject(new Error('Failed older slot'))
            await settleTasks()
        }
        held.resolve({ state: fake('restored'), time: 1 })
        await restoring
        if (order === 'Restore first' || order === 'Undo cancelled') {
            slot.resolve(fake('undone'))
            await settleTasks()
        }
        assert.equal(
            stackMoveRequestGeneration.value,
            request,
            'completion and cancellation are not requests',
        )
        assert.equal(nameOf(liveState.value), order === 'Undo first' ? 'undone' : 'restored')
        assert.deepEqual(notices, order === 'Undo first' ? [] : ['restored 1'])
    })

test('refused Undo and Redo do not advance accepted request generation', () => {
    const request = stackMoveRequestGeneration.value
    undoState()
    redoState()
    assert.equal(stackMoveRequestGeneration.value, request)
})

test('failure callback runs once and cleans up even when it throws', async () => {
    const held = heldEntry()
    let calls = 0
    const restoring = restoreEntry(key(1), () => {
        calls++
        throw new Error('Callback failed')
    })
    assert.deepEqual(held.loads, [key(1)])
    held.reject(new PeekError('damaged'))
    await assert.rejects(restoring, /Callback failed/)
    assert.equal(calls, 1)
    await restoreEntry(key(2))
    assert.equal(nameOf(liveState.value), 'newer')
    assert.deepEqual(notices, ['restored 2'])
})

test('current read failures still reject without a callback', async () => {
    const held = heldEntry()
    const restoring = restoreEntry(key(1))
    assert.deepEqual(held.loads, [key(1)])
    held.reject(new PeekError('removed'))
    await assert.rejects(
        restoring,
        (error: unknown) => error instanceof PeekError && error.reason === 'removed',
    )
})

test('Restore re-grafts audio changed by its synchronous leave hook', async () => {
    source({ [key(1)]: { state: fake('old', 3), time: 1 } })
    await peekEntry(key(1))
    const buffer = {} as AudioBuffer
    const stop = onPeekLeft(() =>
        replaceState({
            ...liveState.value,
            bgm: { ...liveState.value.bgm, buffer },
        }),
    )
    try {
        await restoreEntry(key(1))
        assert.equal(nameOf(liveState.value), 'old')
        assert.equal(liveState.value.bgm.offset, 3)
        assert.equal(liveState.value.bgm.buffer, buffer)
        assert.deepEqual(notices, ['restored 1'])
    } finally {
        stop()
    }
})

test('a synchronous leave hook starting a newer peek prevents the obsolete push', async () => {
    source({
        [key(1)]: { state: fake('old'), time: 1 },
        [key(2)]: { state: fake('newer'), time: 2 },
    })
    await peekEntry(key(1))
    let next: Promise<void> | undefined
    const stop = onPeekLeft(() => {
        next = peekEntry(key(2))
    })
    try {
        await restoreEntry(key(1))
        await next
        assert.equal(nameOf(liveState.value), 'live')
        assert.equal(peekedKey.value, key(2))
        assert.deepEqual(notices, [])
    } finally {
        stop()
    }
})

test('a synchronous action listener edit suppresses obsolete Restore feedback', async () => {
    source({ [key(1)]: { state: fake('old'), time: 1 } })
    const stop = onHistoryAction((action) => {
        if (action.kind === 'restore')
            pushState(initialLife(0, 2), fake('new edit', 0, { initialLife: 2 }))
    })
    try {
        await restoreEntry(key(1))
        assert.equal(nameOf(liveState.value), 'new edit')
        assert.deepEqual(notices, [])
    } finally {
        stop()
    }
})
test('drags end before the peeked state shows', async () => {
    source({ [key(1)]: { state: fake('old'), time: 1 } })
    const seen: string[] = []
    const stop = onPeekStart(() => {
        seen.push(`${String(isPeeking.value)} ${nameOf(state.value)}`)
    })
    await peekEntry(key(1))
    await peekEntry(key(1))
    stop()
    assert.deepEqual(seen, ['false live'])
})

test('requests close together wait for the last, and earlier ones resolve', async () => {
    const loads = source({
        [key(1)]: { state: fake('one'), time: 1 },
        [key(2)]: { state: fake('two'), time: 2 },
        [key(3)]: { state: fake('three'), time: 3 },
    })
    const first = peekEntry(key(1))
    const second = peekEntry(key(2))
    const third = peekEntry(key(3))
    await Promise.all([first, second, third])
    assert.equal(nameOf(state.value), 'three')
    assert.equal(peekedKey.value, key(3))
    // The first ran at once; the second was replaced before its debounce ended.
    assert.deepEqual(loads, [key(1), key(3)])
})

test('the state shows once ready resolves, not before', async () => {
    source({ [key(1)]: { state: fake('one'), time: 1 } })
    const gate = deferred<void>()
    const seen: string[] = []
    const peeking = peekEntry(key(1), {
        ready: (loaded) => {
            seen.push(nameOf(loaded))
            return gate.promise
        },
    })
    await wait(20)
    assert.equal(nameOf(state.value), 'live')
    assert.equal(displayedPeekKey.value, undefined)
    gate.resolve()
    await peeking
    assert.equal(nameOf(state.value), 'one')
    assert.equal(displayedPeekKey.value, key(1))
    assert.deepEqual(seen, ['one'])
})

test('the state shows after the bound when ready does not settle, and a failing ready only ends the wait', async () => {
    source({
        [key(1)]: { state: fake('one'), time: 1 },
        [key(2)]: { state: fake('two'), time: 2 },
    })
    // Clears the debounce window of the previous test's request.
    await wait(110)
    const started = Date.now()
    await peekEntry(key(1), { ready: () => new Promise(() => undefined) })
    const waited = Date.now() - started
    assert.equal(nameOf(state.value), 'one')
    assert.ok(waited >= PEEK_READY_MAX_MS - 20)
    assert.ok(waited < PEEK_READY_MAX_MS + 200)
    await peekEntry(key(2), { ready: () => Promise.reject(new Error('read failed')) })
    assert.equal(nameOf(state.value), 'two')
})

test('a newer request, a leave or a Restore during the wait drops the waiting state', async () => {
    source({
        [key(1)]: { state: fake('one'), time: 1 },
        [key(2)]: { state: fake('two'), time: 2 },
    })
    const gate = deferred<void>()
    const first = peekEntry(key(1), { ready: () => gate.promise })
    await wait(20)
    const second = peekEntry(key(2))
    await Promise.all([first, second])
    assert.equal(nameOf(state.value), 'two')
    gate.resolve()
    await wait(10)
    assert.equal(nameOf(state.value), 'two')

    await wait(110)
    const later = deferred<void>()
    const waiting = peekEntry(key(1), { ready: () => later.promise })
    await wait(20)
    leavePeek()
    await waiting
    later.resolve()
    await wait(10)
    assert.equal(isPeeking.value, false)
    assert.equal(displayedPeekKey.value, undefined)

    await wait(110)
    const restoring = deferred<void>()
    const held = peekEntry(key(1), { ready: () => restoring.promise })
    await wait(20)
    await restoreEntry(key(2))
    await held
    restoring.resolve()
    await wait(10)
    assert.equal(isPeeking.value, false)
    assert.equal(nameOf(liveState.value), 'two')
})

test('a request waiting out the debounce runs at once on runPendingPeek, and only the latest runs', async () => {
    const loads = source({
        [key(1)]: { state: fake('one'), time: 1 },
        [key(2)]: { state: fake('two'), time: 2 },
        [key(3)]: { state: fake('three'), time: 3 },
    })
    runPendingPeek()
    const first = peekEntry(key(1))
    const second = peekEntry(key(2))
    const third = peekEntry(key(3))
    await first
    const flushed = Date.now()
    runPendingPeek()
    await Promise.all([second, third])
    // Well inside the debounce: the third was shown without waiting for it.
    assert.ok(Date.now() - flushed < PEEK_DEBOUNCE_MS / 2)
    assert.equal(nameOf(state.value), 'three')
    assert.deepEqual(loads, [key(1), key(3)])
    // Nothing waits now.
    runPendingPeek()
    await wait(PEEK_DEBOUNCE_MS + 20)
    assert.deepEqual(loads, [key(1), key(3)])
})

test('an entry that cannot be read rejects and leaves the peek', async () => {
    source({}, [key(1)])
    await assert.rejects(peekEntry(key(1)), (error: unknown) => {
        assert.ok(error instanceof PeekError)
        assert.equal(error.reason, 'damaged')
        return true
    })
    assert.equal(isPeeking.value, false)
    assert.equal(nameOf(state.value), 'live')
    assert.equal(displayedPeekKey.value, undefined)
})

test('a failure of a replaced request leaves the newer peek alone', async () => {
    source({ [key(2)]: { state: fake('two'), time: 2 } }, [key(1)])
    const first = peekEntry(key(1))
    const second = peekEntry(key(2))
    await first
    await second
    assert.equal(nameOf(state.value), 'two')
    assert.equal(displayedPeekKey.value, key(2))
})

test('leaving runs the leave hooks; a reset ends the peek without them', async () => {
    source({ [key(1)]: { state: fake('old'), time: 1 } })
    let left = 0
    const stop = onPeekLeft(() => left++)
    await peekEntry(key(1))
    leavePeek()
    assert.equal(left, 1)
    await wait(110)
    await peekEntry(key(1))
    resetStates({ isDirty: false, step: initialStep(), state: fake('new') })
    assert.equal(isPeeking.value, false)
    assert.equal(peekedKey.value, undefined)
    assert.equal(displayedPeekKey.value, undefined)
    assert.equal(left, 1)
    stop()
})

test('a load that finishes after leaving shows nothing', async () => {
    source({ [key(1)]: { state: fake('old'), time: 1 } })
    const shown = peekEntry(key(1))
    leavePeek()
    await shown
    assert.equal(isPeeking.value, false)
    assert.equal(nameOf(state.value), 'live')
    assert.equal(displayedPeekKey.value, undefined)
})

test('readiness retains the displayed endpoint while another request loads', async () => {
    const pending = deferred<PeekedEntry>()
    const started = deferred<void>()
    setPeekSource({
        load: async (entry) => {
            if (entry === key(2)) {
                started.resolve()
                return pending.promise
            }
            return { state: fake('one'), time: 1 }
        },
        sameSnapshot: (a, b) => a === b,
    })
    await peekEntry(key(1))
    const second = peekEntry(key(2))
    await started.promise
    assert.equal(peekedKey.value, key(2))
    assert.equal(displayedPeekKey.value, key(1))
    const firstAgain = peekEntry(key(1))
    assert.equal(displayedPeekKey.value, peekedKey.value)
    pending.resolve({ state: fake('two'), time: 2 })
    await Promise.all([firstAgain, second])
    assert.equal(displayedPeekKey.value, key(1))
    assert.equal(nameOf(state.value), 'one')
    replaceState({ ...state.value, selectedEntities: [] })
    assert.equal(displayedPeekKey.value, key(1))
})

for (const sameSource of [false, true])
    test(`source reset invalidates a pending peek (${sameSource ? 'same source' : 'replacement'})`, async () => {
        const pending = deferred<PeekedEntry>()
        const started = deferred<void>()
        const original = {
            load: () => {
                started.resolve()
                return pending.promise
            },
            sameSnapshot: (a: State, b: State) => a === b,
        }
        setPeekSource(original)
        const loading = peekEntry(key(1))
        await started.promise
        assert.equal(displayedPeekKey.value, undefined)
        setPeekSource(
            sameSource
                ? original
                : {
                      ...original,
                      load: async () => ({ state: fake('replacement'), time: 2 }),
                  },
        )
        pending.resolve({ state: fake('stale'), time: 1 })
        await loading
        await settleTasks()
        assert.equal(isPeeking.value, false)
        assert.equal(peekedKey.value, undefined)
        assert.equal(displayedPeekKey.value, undefined)
        assert.equal(nameOf(state.value), 'live')
    })

test('pushState while peeking throws in tests, and nothing changes', async () => {
    source({ [key(1)]: { state: fake('old'), time: 1 } })
    await peekEntry(key(1))
    assert.throws(() => {
        pushState(initialLife(0, 1), fake('edit'))
    }, /while viewing history/)
    assert.equal(nameOf(liveState.value), 'live')
})

test('Restore pushes a restore entry with the snapshot’s chart and offset and the live audio', async () => {
    const buffer = {} as AudioBuffer
    resetStates({
        isDirty: false,
        step: initialStep(),
        state: fake('live', 0, { bgm: { offset: 0, buffer, filename: 'song.mp3' } }),
    })
    source({ [key(1)]: { state: fake('old', 3, { bgm: { offset: 3 } }), time: 1234 } })
    const actions: HistoryAction[] = []
    const stop = onHistoryAction((action) => actions.push(action))
    await peekEntry(key(1))
    await restoreEntry(key(1))
    stop()
    assert.equal(isPeeking.value, false)
    assert.equal(nameOf(liveState.value), 'old')
    assert.equal(liveState.value.bgm.offset, 3)
    assert.equal(liveState.value.bgm.buffer, buffer)
    assert.equal(liveState.value.bgm.filename, 'song.mp3')
    assert.deepEqual(
        actions.map((action) => action.kind),
        ['restore'],
    )
    assert.equal(actions[0]?.kind, 'restore')
    const action = actions[0]
    assert(action && 'step' in action)
    assert.deepEqual(
        action.step.operation,
        nativeOperation({ id: 'nse.restore', data: { targetTime: 1234 } }, 'Restored to 1234'),
    )
    assert.deepEqual(notices, ['restored 1234'])
    // Undoable.
    undoState()
    assert.equal(nameOf(liveState.value), 'live')
})

const bgmOf = (hash: string, offset: number) => ({
    offset,
    meta: { hash, filename: `${hash}.mp3`, size: 1, type: 'audio/mpeg' },
})

test('Restore after a BGM change keeps the current offset with the current audio', async () => {
    const buffer = {} as AudioBuffer
    resetStates({
        isDirty: false,
        step: initialStep(),
        state: fake('live', 0, { bgm: { ...bgmOf('new', 7), buffer } }),
    })
    source({ [key(1)]: { state: fake('old', 0, { bgm: bgmOf('old', 3) }), time: 1 } })
    await restoreEntry(key(1))
    assert.equal(nameOf(liveState.value), 'old')
    assert.equal(liveState.value.bgm.offset, 7)
    assert.equal(liveState.value.bgm.meta?.hash, 'new')
    assert.equal(liveState.value.bgm.buffer, buffer)
    // Undo returns the offset too.
    undoState()
    assert.equal(nameOf(liveState.value), 'live')
    assert.equal(liveState.value.bgm.offset, 7)
})

test('Restore with an unchanged BGM restores the step’s offset', async () => {
    resetStates({
        isDirty: false,
        step: initialStep(),
        state: fake('live', 0, { bgm: bgmOf('same', 7) }),
    })
    source({ [key(1)]: { state: fake('old', 0, { bgm: bgmOf('same', 3) }), time: 1 } })
    await restoreEntry(key(1))
    assert.equal(nameOf(liveState.value), 'old')
    assert.equal(liveState.value.bgm.offset, 3)
})

test('a step’s peek plays with its offset only when its BGM is the current one', async () => {
    const buffer = {} as AudioBuffer
    resetStates({
        isDirty: false,
        step: initialStep(),
        state: fake('live', 0, { bgm: { ...bgmOf('new', 7), buffer } }),
    })
    source({
        [key(1)]: { state: fake('old', 0, { bgm: bgmOf('old', 3) }), time: 1 },
        [key(2)]: { state: fake('same', 0, { bgm: bgmOf('new', 5) }), time: 2 },
    })
    await peekEntry(key(1))
    // The peek shows the step’s offset; playback keeps the live one with the live audio.
    assert.equal(state.value.bgm.offset, 3)
    assert.equal(playbackBgm.value.offset, 7)
    assert.equal(playbackBgm.value.buffer, buffer)
    await peekEntry(key(2))
    assert.equal(playbackBgm.value.offset, 5)
    assert.equal(playbackBgm.value.buffer, buffer)
    leavePeek()
    assert.equal(playbackBgm.value.offset, 7)
})

test('Restore while the peek still loads reads the entry once', async () => {
    const loads = source({ [key(1)]: { state: fake('old'), time: 1 } })
    const peeking = peekEntry(key(1))
    await restoreEntry(key(1))
    await peeking
    assert.deepEqual(loads, [key(1)])
    assert.equal(nameOf(liveState.value), 'old')
})

test('Restore of what the chart already is pushes nothing', async () => {
    source({ [key(1)]: { state: fake('live'), time: 1 } })
    const actions: HistoryAction[] = []
    const stop = onHistoryAction((action) => actions.push(action))
    await restoreEntry(key(1))
    stop()
    assert.deepEqual(actions, [])
    assert.deepEqual(notices, ['matches'])
})

test('states are kept for peeking, the least recently used dropped first', async () => {
    const entries: Record<string, PeekedEntry> = {}
    for (let seq = 0; seq <= PEEK_LRU; seq++)
        entries[key(seq)] = { state: fake(`s${seq}`), time: seq }
    const loads = source(entries)
    for (let seq = 0; seq <= PEEK_LRU; seq++) {
        await peekEntry(key(seq))
        await wait(110)
    }
    await peekEntry(key(PEEK_LRU))
    await wait(110)
    await peekEntry(key(0))
    assert.equal(loads.filter((each) => each === key(PEEK_LRU)).length, 1)
    assert.equal(loads.filter((each) => each === key(0)).length, 2)
})

const command = (flags: Partial<Command> = {}) => {
    const runs: boolean[] = []
    const value: Command = {
        title: () => 'Test',
        icon: { is: {} },
        execute: () => {
            runs.push(isPeeking.value)
        },
        ...flags,
    }
    return { value, runs }
}

test('runCommand refuses edits while peeking and says why; Open, New, Undo and Redo run and leave themselves', async () => {
    source({ [key(1)]: { state: fake('old'), time: 1 } })
    const refusals: string[] = []
    const stop = onPeekRefused((refusal) => refusals.push(refusal.title?.() ?? ''))
    const edit = command()
    const view = command({ readOnly: true })
    const leave = command({ leavesPeek: true })
    await peekEntry(key(1))
    void runCommand(edit.value)
    void runCommand(view.value)
    assert.deepEqual(edit.runs, [])
    assert.deepEqual(view.runs, [true])
    assert.deepEqual(refusals, ['Test'])
    // It runs with the peek in place: a cancelled picker or nothing to undo keeps the peek.
    void runCommand(leave.value)
    assert.deepEqual(leave.runs, [true])
    assert.equal(isPeeking.value, true)
    leavePeek()
    void runCommand(edit.value)
    assert.deepEqual(edit.runs, [false])
    stop()
})

test('a Restore whose session a New replaced meanwhile pushes nothing', async () => {
    source({ [key(1)]: { state: fake('old'), time: 1 } })
    const restoring = restoreEntry(key(1))
    resetStates({ isDirty: false, step: initialStep(), state: fake('new') })
    await restoring
    assert.equal(nameOf(liveState.value), 'new')
    assert.deepEqual(notices, [])
})

test('a Restore description failure preserves the current peek and live stack', async () => {
    source({ [key(1)]: { state: fake('old'), time: 1234 } })
    await peekEntry(key(1))
    const live = liveState.value
    setPeekEffects({
        restoredOperation: () => {
            throw new Error('Description failed')
        },
        restored: () => assert.fail('Restore did not complete'),
        alreadyMatches: () => undefined,
    })
    try {
        await assert.rejects(restoreEntry(key(1)), /Description failed/)
        assert.equal(isPeeking.value, true)
        assert.equal(liveState.value, live)
        assert.equal(nameOf(state.value), 'old')
    } finally {
        setPeekEffects({
            restoredOperation: (time) =>
                nativeOperation(
                    { id: 'nse.restore', data: { targetTime: time } },
                    'Restored to ' + time,
                ),
            restored: (time) => notices.push('restored ' + time),
            alreadyMatches: () => notices.push('matches'),
        })
    }
})

for (const replacement of ['same', 'different', 'absent'] as const)
    test(`a pending Restore cannot cross a ${replacement} source replacement`, async () => {
        const pending = deferred<PeekedEntry>()
        let loads = 0
        const oldSource = {
            load: () => {
                loads++
                return loads === 1
                    ? pending.promise
                    : Promise.resolve({ state: fake('fresh'), time: 2 })
            },
            sameSnapshot: () => false,
        }
        setPeekSource(oldSource)
        const restoring = restoreEntry(key(1))
        setPeekSource(
            replacement === 'same'
                ? oldSource
                : replacement === 'absent'
                  ? undefined
                  : {
                        load: async () => ({ state: fake('replacement'), time: 3 }),
                        sameSnapshot: () => false,
                    },
        )
        pending.resolve({ state: fake('stale'), time: 1 })
        await restoring
        assert.equal(nameOf(liveState.value), 'live')
        assert.deepEqual(notices, [])
        if (replacement === 'same') {
            await peekEntry(key(1))
            assert.equal(nameOf(state.value), 'fresh')
            assert.equal(loads, 2, 'an old load cannot repopulate a replaced source cache')
        }
    })
