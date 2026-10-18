import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'
import { setImmediate as settleTasks } from 'node:timers/promises'
import type { Command } from '../../src/editor/commands'
import { runCommand } from '../../src/editor/commands/runCommand'
import { onHistoryAction, type HistoryAction } from '../../src/history/actions'
import {
    displayedPeekKey,
    entryKey,
    isPeeking,
    leavePeek,
    onPeekLeft,
    onPeekRefused,
    onPeekStart,
    parseEntryKey,
    PEEK_LRU,
    peekedKey,
    peekEntry,
    PeekError,
    resetPeekForTests,
    restoreEntry,
    setPeekEffects,
    setPeekSource,
    type EntryKey,
    type PeekedEntry,
} from '../../src/history/peek'
import {
    liveState,
    pushState,
    replaceState,
    resetStates,
    state,
    undoState,
} from '../../src/history/stack'
import type { State } from '../../src/state'

// Peek's core (Part 1 §1.4.11) in Node: the override, debounced requests, failures, leaving,
// Restore (§1.4.10.5), the state cache and runCommand's gate with the refusal hook.

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
    restoredLabel: (time) => () => `Restored to ${time}`,
    restored: (time) => notices.push(`restored ${time}`),
    alreadyMatches: () => notices.push('matches'),
})

const key = (seq: number): EntryKey => entryKey('session', seq)

beforeEach(async () => {
    resetPeekForTests()
    notices.length = 0
    // Clears the debounce window of an earlier test.
    await wait(110)
    resetStates({ isDirty: false, name: () => 'live', state: fake('live') })
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
        name: () => 'live',
        state: fake('live', 0, { bgm: { offset: 0, buffer } }),
    })
    const selected = [{}] as State['selectedEntities']
    source({ [key(1)]: { state: fake('old', 2, { selectedEntities: selected }), time: 1 } })
    await peekEntry(key(1))
    assert.deepEqual(state.value.selectedEntities, [])
    assert.equal(state.value.bgm.buffer, buffer)
    assert.equal(state.value.bgm.offset, 2)
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
    resetStates({ isDirty: false, name: () => 'new', state: fake('new') })
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
    const pending = Promise.withResolvers<PeekedEntry>()
    const started = Promise.withResolvers<void>()
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
        const pending = Promise.withResolvers<PeekedEntry>()
        const started = Promise.withResolvers<void>()
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
        pushState(() => 'edit', fake('edit'))
    }, /while viewing history/)
    assert.equal(nameOf(liveState.value), 'live')
})

test('Restore pushes a restore entry with the snapshot’s chart and offset and the live audio', async () => {
    const buffer = {} as AudioBuffer
    resetStates({
        isDirty: false,
        name: () => 'live',
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
    assert.equal(actions[0]?.name(), 'Restored to 1234')
    assert.deepEqual(notices, ['restored 1234'])
    // Undoable.
    undoState()
    assert.equal(nameOf(liveState.value), 'live')
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

test('runCommand refuses edits while peeking and says why; Open, New, Undo and Redo leave first', async () => {
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
    void runCommand(leave.value)
    assert.deepEqual(leave.runs, [false])
    assert.equal(isPeeking.value, false)
    void runCommand(edit.value)
    assert.deepEqual(edit.runs, [false])
    stop()
})

test('a Restore whose session a New replaced meanwhile pushes nothing', async () => {
    source({ [key(1)]: { state: fake('old'), time: 1 } })
    const restoring = restoreEntry(key(1))
    resetStates({ isDirty: false, name: () => 'new', state: fake('new') })
    await restoring
    assert.equal(nameOf(liveState.value), 'new')
    assert.deepEqual(notices, [])
})
