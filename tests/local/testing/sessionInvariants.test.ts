import assert from 'node:assert/strict'
import test from 'node:test'
import { captureName } from '../../../src/history/operations'
import type { Key } from '../../../src/local/kv/types'
import { replayViolations, sessionViolations } from '../../../src/local/testing/invariants'
import { nativeOperation, originOperation } from '../../helpers/historySteps'

// The session invariants of architecture review A (R-A1, R-A2): each is reported for the rows that
// break it, and a whole session reports none.

const entry = (sessionId: string, seq: number, time: number, extra: object = {}) => ({
    key: [sessionId, seq] as Key,
    value: { sessionId, seq, time, kind: 'edit', ...extra },
})

const session = (id: string, extra: object = {}) => ({
    key: id,
    value: { id, chainId: 'c', lastSeq: 3, entryCount: 3, stack: {}, ...extra },
})

const dump = (
    sessions: ReturnType<typeof session>[],
    entries: ReturnType<typeof entry>[],
    chain: object = {},
    maxSeenTime = 100,
) =>
    new Map<string, { key: Key; value: unknown }[]>([
        ['sessions', sessions],
        ['entries', entries],
        ['chains', [{ key: 'c', value: { chainId: 'c', ...chain } }]],
        ['meta', [{ key: 'maxSeenTime', value: { key: 'maxSeenTime', value: maxSeenTime } }]],
    ])

const whole = () => [entry('s', 1, 10), entry('s', 2, 20), entry('s', 3, 30)]

test('a whole session reports nothing', () => {
    assert.deepEqual(sessionViolations(dump([session('s')], whole())), [])
})

test('a row above lastSeq is named', () => {
    const rows = [...whole(), entry('s', 4, 40)]
    assert.deepEqual(sessionViolations(dump([session('s', { entryCount: 4 })], rows)), [
        'session s: rows 4 lie above lastSeq 3',
    ])
})

test('a seq up to lastSeq with no row is named, unless covered, the binding’s own or let go', () => {
    const rows = [entry('s', 1, 10), entry('s', 3, 30)]
    const stored = session('s', { entryCount: 2 })
    const [hole] = sessionViolations(dump([stored], rows))
    assert.match(hole!, /session s: rows 2 up to lastSeq 3 are neither stored/)
    const covered = [entry('s', 1, 10), entry('s', 3, 30, { kind: 'recovered' })]
    assert.deepEqual(sessionViolations(dump([stored], covered)), [])
    const own = { file: { entry: { sessionId: 's', seq: 2 } } }
    assert.deepEqual(sessionViolations(dump([stored], rows, own)), [])
    assert.deepEqual(
        sessionViolations(dump([stored], rows), { hole: (id, seq) => id === 's' && seq === 2 }),
        [],
    )
    // Rows still to come while an import is pending.
    assert.deepEqual(sessionViolations(dump([session('s', { importPending: true })], rows)), [])
})

test('a row stamped later than the row above it is named', () => {
    const rows = [entry('s', 1, 10), entry('s', 2, 50), entry('s', 3, 30)]
    assert.deepEqual(sessionViolations(dump([session('s')], rows)), [
        'session s: row 2 (time 50) is later than row 3 (time 30)',
    ])
})

test('a time past maxSeenTime is named, unless the check is off', () => {
    const rows = [entry('s', 1, 10), entry('s', 2, 20), entry('s', 3, 300)]
    const [past] = sessionViolations(dump([session('s')], rows))
    assert.match(past!, /rows 3 have a time past maxSeenTime 100/)
    assert.deepEqual(sessionViolations(dump([session('s')], rows), { maxSeenTime: false }), [])
})

test('a parent row past a continuation’s uptoSeq is named', () => {
    const parent = session('p', { lastSeq: 3, entryCount: 3 })
    const child = session('k', { lastSeq: 1, entryCount: 1, parent: { id: 'p', uptoSeq: 2 } })
    const rows = [entry('p', 1, 10), entry('p', 2, 20), entry('p', 3, 30), entry('k', 1, 40)]
    assert.deepEqual(sessionViolations(dump([parent, child], rows)), [
        'session k: parent p holds rows 3 past its uptoSeq 2',
        'session k: parent p has lastSeq 3, not its uptoSeq 2',
    ])
})

test('an entryCount that is not the number of rows is named', () => {
    assert.deepEqual(sessionViolations(dump([session('s', { entryCount: 4 })], whole())), [
        'session s: entryCount 4 but 3 rows are stored',
    ])
})

test('a key that is not the row’s own session and seq is named', () => {
    const rows = [
        entry('s', 1, 10),
        { ...entry('s', 2, 20), key: ['s', 3] as Key },
        entry('s', 3, 30),
    ]
    const [mismatch] = sessionViolations(dump([session('s')], rows))
    assert.match(mismatch!, /its row says session s seq 2/)
})

test('a session opened from a file keeps its rows’ own times: no time check', () => {
    const rows = [entry('s', 1, 10), entry('s', 2, 500), entry('s', 3, 30)]
    for (const origin of ['nxsp', 'replaced'])
        assert.deepEqual(sessionViolations(dump([session('s', { origin })], rows)), [])
    assert.equal(sessionViolations(dump([session('s', { origin: 'import' })], rows)).length, 2)
})

// A0+ corrections (design A §7): the parent rule is for a parent in the same chain, an opened
// session's holes are allowed once its import ended, learned holes are allowed, and replay runs
// for every followable session, stack or not.

test('a fork’s parent may go on as its own chain’s head: no parent rule across chains (F3)', () => {
    const parent = session('p', { lastSeq: 3, entryCount: 3 })
    const fork = session('f', {
        chainId: 'other',
        lastSeq: 1,
        entryCount: 1,
        parent: { id: 'p', uptoSeq: 2 },
    })
    const rows = [entry('p', 1, 10), entry('p', 2, 20), entry('p', 3, 30), entry('f', 1, 40)]
    const found = dump([parent, fork], rows)
    found.set('chains', [
        { key: 'c', value: { chainId: 'c' } },
        { key: 'other', value: { chainId: 'other' } },
    ])
    assert.deepEqual(sessionViolations(found), [])
})

test('rows an ended import never brought are holes the plan allows; a plain session’s are not (F3)', () => {
    const rows = [entry('s', 1, 10), entry('s', 3, 30)]
    const stored = (extra: object) => session('s', { entryCount: 2, ...extra })
    for (const origin of ['nxsp', 'replaced'])
        assert.deepEqual(sessionViolations(dump([stored({ origin })], rows)), [])
    assert.match(
        sessionViolations(dump([stored({ origin: 'import' })], rows))[0]!,
        /rows 2 up to lastSeq 3 are neither stored/,
    )
})

test('a learned hole is allowed only for the seq learned', () => {
    const rows = [entry('s', 1, 10), entry('s', 4, 40)]
    const stored = session('s', { lastSeq: 4, entryCount: 2 })
    const learned = new Set(['s#2'])
    const found = sessionViolations(dump([stored], rows), {
        hole: (id, seq) => learned.has(`${id}#${seq}`),
    })
    assert.equal(found.length, 1)
    assert.match(found[0]!, /rows 3 up to lastSeq 4/)
})

test('a session with no stored stack is replayed: a save that does not land is named (I-8)', () => {
    const snapshot = (n: number) => new Uint8Array(16).fill(n)
    const base = {
        sessionId: 's',
        day: 1,
        dirty: false,
        kept: true,
        noteCount: 1,
    }
    const rows = [
        {
            key: ['s', 1] as Key,
            value: {
                ...base,
                seq: 1,
                time: 10,
                kind: 'init',
                operation: originOperation('import'),
                snapshot: snapshot(1),
            },
        },
        {
            key: ['s', 2] as Key,
            value: {
                ...base,
                seq: 2,
                time: 20,
                kind: 'save',
                operation: nativeOperation(
                    {
                        id: 'nse.file.save',
                        data: { file: captureName('c.nxsp'), delivery: 'file' },
                    },
                    'Saved c.nxsp',
                ),
                snapshot: snapshot(2),
            },
        },
    ]
    const found = replayViolations(
        dump([session('s', { lastSeq: 2, stack: undefined })], rows as never),
    )
    assert.equal(found.length, 1)
    assert.match(found[0]!, /session s: .*its snapshot is not the slot it lands on/)
    // The same save landing on its slot is clean; an unfinished import is not replayed.
    rows[1]!.value.snapshot = snapshot(1)
    assert.deepEqual(
        replayViolations(dump([session('s', { lastSeq: 2, stack: undefined })], rows as never)),
        [],
    )
    rows[1]!.value.snapshot = snapshot(2)
    assert.deepEqual(
        replayViolations(
            dump(
                [session('s', { lastSeq: 2, stack: undefined, importPending: true })],
                rows as never,
            ),
        ),
        [],
    )
})
