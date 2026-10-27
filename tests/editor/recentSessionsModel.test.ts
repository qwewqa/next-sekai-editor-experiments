import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveZone } from '../../src/calendar/calendar'
import { calendarAt } from '../../src/editor/history/calendarClock'
import {
    buildRows,
    createRecentList,
    peekable,
    restoreMode,
    type ChainRow,
    type ListContext,
    type ListRow,
} from '../../src/editor/history/sessions'
import type { RecentChain } from '../../src/local/recent'
import type { StoredRead } from '../../src/local/storedRead'

// Recent Sessions' list model: which rows there are and which badge each has,
// what Restore does for each, and when a refresh may change rows under the pointer.

const UTC = resolveZone('UTC')
const NOW = Date.UTC(2026, 9, 20, 15, 0)
const calendar = calendarAt(NOW, UTC)
const HOUR = 3_600_000

const chain = (id: string, ago: number, rest: Partial<RecentChain> = {}): RecentChain => ({
    chainId: id,
    updatedAt: NOW - ago,
    head: { sessionId: `${id}-head`, lastSeq: 3, startedAt: NOW - ago - HOUR },
    nameParts: {},
    changed: false,
    readable: 'yes',
    ...rest,
})

const context = (rest: Partial<ListContext> = {}): ListContext => ({
    calendar,
    thisChain: undefined,
    elsewhere: new Set(),
    failed: new Map(),
    deleted: new Map(),
    ...rest,
})

const chainRows = (rows: ListRow[]) => rows.filter((row): row is ChainRow => row.type === 'chain')

test('rows keep the read order under one day header for each day', () => {
    const rows = buildRows(
        [chain('a', HOUR), chain('b', 2 * HOUR), chain('c', 30 * HOUR), chain('d', 31 * HOUR)],
        context(),
    )
    assert.deepEqual(
        rows.map((row) => (row.type === 'header' ? `day ${row.level}` : row.id)),
        ['day day', 'a', 'b', 'day day', 'c', 'd'],
    )
})

test("only this tab's chain has the This tab badge, and no chain has two badges", () => {
    // This tab holds its own head's lock, so the other-tab query never lists it; a chain open in
    // both would still show one badge.
    const rows = chainRows(
        buildRows(
            [chain('own', HOUR), chain('other', 2 * HOUR), chain('quiet', 3 * HOUR)],
            context({
                thisChain: 'own',
                elsewhere: new Set(['own-head', 'other-head']),
            }),
        ),
    )
    assert.deepEqual(
        rows.map((row) => [row.id, row.badge, row.thisTab]),
        [
            ['own', 'thisTab', true],
            ['other', 'elsewhere', false],
            ['quiet', undefined, false],
        ],
    )
})

test("a continuation that has not stored yet keeps its chain's row as This tab", () => {
    // Its session is not stored, so the head is the parent's: the chain id carries the badge.
    const rows = chainRows(buildRows([chain('own', HOUR)], context({ thisChain: 'own' })))
    assert.equal(rows[0]?.thisTab, true)
})

test('a chain from a newer version or a damaged one is listed, and cannot be peeked or restored', () => {
    const rows = chainRows(
        buildRows(
            [
                chain('ok', HOUR),
                chain('newer', 2 * HOUR, { readable: 'newer' }),
                chain('bad', 3 * HOUR, { readable: 'damaged' }),
            ],
            context(),
        ),
    )
    assert.deepEqual(
        rows.map((row) => [row.id, peekable(row), restoreMode(row, false)]),
        [
            ['ok', true, 'restore'],
            ['newer', false, undefined],
            ['bad', false, undefined],
        ],
    )
})

test('a row a peek found unreadable reads so from then on', () => {
    const rows = chainRows(
        buildRows(
            [chain('a', HOUR), chain('b', 2 * HOUR)],
            context({ failed: new Map([['a', 'damaged' as const]]) }),
        ),
    )
    assert.deepEqual(
        rows.map((row) => row.readable),
        ['damaged', 'yes'],
    )
})

test('Restore is a copy for a head held elsewhere and in safe mode, and none for this tab', () => {
    const [own, other, quiet] = chainRows(
        buildRows(
            [chain('own', HOUR), chain('other', 2 * HOUR), chain('quiet', 3 * HOUR)],
            context({ thisChain: 'own', elsewhere: new Set(['other-head']) }),
        ),
    )
    assert.ok(own && other && quiet)
    assert.equal(restoreMode(own, false), undefined)
    assert.equal(restoreMode(other, false), 'copy')
    assert.equal(restoreMode(quiet, false), 'restore')
    assert.equal(restoreMode(quiet, true), 'copy')
})

// --- The refresh

/** A read that lands when released, so the order of landings is the test's. */
const gated = () => {
    const calls: { resolve: (read: StoredRead<RecentChain[]>) => void }[] = []
    return {
        calls,
        read: () =>
            new Promise<StoredRead<RecentChain[]>>((resolve) => {
                calls.push({ resolve })
            }),
    }
}

const value = (chains: RecentChain[]): StoredRead<RecentChain[]> => ({
    storedRead: 'value',
    storedValue: chains,
})
const failure: StoredRead<RecentChain[]> = { storedRead: 'failed', storedError: new Error('no') }

const listOf = (read: () => Promise<StoredRead<RecentChain[]>>) =>
    createRecentList({ read, elsewhere: () => Promise.resolve(new Set()) })

const ids = (list: ReturnType<typeof listOf>) => list.chains.value.map((each) => each.chainId)

test('a read that fails before anything is shown is failed, never an empty list, and Try Again reads again', async () => {
    const reads = [failure, value([chain('a', HOUR)])]
    const list = listOf(() => Promise.resolve(reads.shift() ?? failure))
    await list.refresh()
    assert.equal(list.status.value, 'failed')
    assert.deepEqual(ids(list), [])
    const again = list.refresh({ now: true })
    assert.equal(list.status.value, 'loading')
    await again
    assert.equal(list.status.value, 'ready')
    assert.deepEqual(ids(list), ['a'])
})

test('a refresh that fails behind a shown list keeps the list', async () => {
    const reads = [value([chain('a', HOUR)]), failure]
    const list = listOf(() => Promise.resolve(reads.shift() ?? failure))
    await list.refresh()
    await list.refresh()
    assert.equal(list.status.value, 'ready')
    assert.deepEqual(ids(list), ['a'])
})

test('rows hold still: a refresh while the pointer is over the list waits for it to leave', async () => {
    const reads = [value([chain('a', HOUR)]), value([chain('new', 0), chain('a', HOUR)])]
    let count = 0
    const list = listOf(() => {
        count++
        return Promise.resolve(reads.shift() ?? failure)
    })
    await list.refresh()
    list.hold('pointer', true)
    await list.refresh()
    assert.equal(count, 1, 'no read while held')
    assert.equal(list.deferred(), true)
    assert.deepEqual(ids(list), ['a'])
    list.hold('pointer', false)
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve))
    assert.deepEqual(ids(list), ['new', 'a'])
    assert.equal(list.deferred(), false)
})

test('rows hold still until both the pointer and focus leave, and a hold released twice reads once', async () => {
    let count = 0
    const list = listOf(() => {
        count++
        return Promise.resolve(value([chain('a', HOUR)]))
    })
    await list.refresh()
    list.hold('pointer', true)
    list.hold('focus', true)
    await list.refresh()
    list.hold('pointer', false)
    await new Promise((resolve) => setTimeout(resolve))
    assert.equal(count, 1, 'focus is still in the list')
    list.hold('focus', false)
    list.hold('focus', false)
    await new Promise((resolve) => setTimeout(resolve))
    assert.equal(count, 2)
})

test('a read that lands while the pointer is over the list is kept for later', async () => {
    const gate = gated()
    const list = listOf(gate.read)
    const first = list.refresh()
    gate.calls[0]?.resolve(value([chain('a', HOUR)]))
    await first
    const second = list.refresh()
    list.hold('pointer', true)
    gate.calls[1]?.resolve(value([chain('b', HOUR)]))
    await second
    assert.deepEqual(ids(list), ['a'], 'the rows did not change under the pointer')
    assert.equal(list.deferred(), true)
})

test("the user's own action applies at once, whatever holds the rows", async () => {
    const reads = [value([chain('a', HOUR)]), value([])]
    const list = listOf(() => Promise.resolve(reads.shift() ?? failure))
    await list.refresh()
    list.hold('pointer', true)
    await list.refresh({ now: true })
    assert.deepEqual(ids(list), [])
})

test('an older read that lands after a newer one does not replace it', async () => {
    const gate = gated()
    const list = listOf(gate.read)
    const older = list.refresh({ now: true })
    const newer = list.refresh({ now: true })
    gate.calls[1]?.resolve(value([chain('new', 0)]))
    await newer
    gate.calls[0]?.resolve(value([chain('old', HOUR)]))
    await older
    assert.deepEqual(ids(list), ['new'])
})

test('a list closed before its read lands shows nothing', async () => {
    const gate = gated()
    const list = listOf(gate.read)
    const reading = list.refresh()
    list.dispose()
    gate.calls[0]?.resolve(value([chain('a', HOUR)]))
    await reading
    assert.deepEqual(ids(list), [])
    assert.equal(list.status.value, 'loading')
})

// The first read is a refresh with nothing shown yet: held rows only matter once there are some.
test('the first read lands even when the pointer is already over the list', async () => {
    const list = listOf(() => Promise.resolve(value([chain('a', HOUR)])))
    list.hold('pointer', true)
    await list.refresh()
    assert.deepEqual(ids(list), ['a'])
})

test('a chain marked for Delete stands as its inline row where it was, also once the read drops it', () => {
    const deleted = (id: string, ago: number, status: 'deleted' | 'lost' = 'deleted') =>
        [
            id,
            { chain: chain(id, ago), name: id.toUpperCase(), mark: { chainId: id, at: 1 }, status },
        ] as const
    // Listed and marked: the inline row replaces the chain's row.
    let rows = buildRows(
        [chain('a', HOUR), chain('b', 2 * HOUR)],
        context({ deleted: new Map([deleted('a', HOUR)]) }),
    )
    assert.deepEqual(
        rows.map((row) => (row.type === 'header' ? 'day' : `${row.type}:${row.id}`)),
        ['day', 'deleted:a', 'chain:b'],
    )
    // The read no longer lists it (it is marked in storage): it goes back in by its last edit.
    rows = buildRows(
        [chain('a', HOUR), chain('c', 3 * HOUR)],
        context({ deleted: new Map([deleted('b', 2 * HOUR, 'lost')]) }),
    )
    assert.deepEqual(
        rows.map((row) => (row.type === 'header' ? 'day' : `${row.type}:${row.id}`)),
        ['day', 'chain:a', 'deleted:b', 'chain:c'],
    )
    // Newest of all, and oldest of all.
    rows = buildRows(
        [chain('b', 2 * HOUR)],
        context({ deleted: new Map([deleted('a', HOUR), deleted('z', 40 * HOUR)]) }),
    )
    assert.deepEqual(
        rows.map((row) => (row.type === 'header' ? 'day' : `${row.type}:${row.id}`)),
        ['day', 'deleted:a', 'chain:b', 'day', 'deleted:z'],
    )
})
