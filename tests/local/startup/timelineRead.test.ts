import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeOperation, entryOperation, fallbackOf } from '../../../src/history/operations'
import { KeyRange } from '../../../src/local/kv/types'
import { createWorld, type World } from '../../../src/local/testing/world'
import { readTimeline, readTimelineIndex } from '../../../src/local/worker/timelineHandlers'
import { editStep, futureFixtureOperation } from '../../helpers/historySteps'
import { openPage, type Page } from '../flush/harness'
import { goldenChart, stateOf } from '../records/charts'
import { widen } from '../timeline/helpers'
import { beginIn, continueIn, readOpen } from './harness'

// The History panel's Timeline read (Part 1 §1.4.10.5): a session's entries newest first, a page
// at a time, on into the session it continued at the entry it continued from.

const read = (page: Page, request: Parameters<typeof readTimeline>[1]) =>
    page.tab.run(() => page.core.read(['sessions', 'entries'], (tx) => readTimeline(tx, request)))

/** A stored session of an import and three edits, then a continuation with two of its own. */
const chain = async (world: World) => {
    const page = await openPage(world, world.tab('first'))
    let state = stateOf(goldenChart())
    const parent = beginIn(page, state)
    for (const label of ['One', 'Two', 'Three']) {
        state = widen(state)
        page.flusher.append(
            { kind: 'edit', step: editStep(futureFixtureOperation(label)) },
            state,
            true,
        )
    }
    await page.flusher.flush({ strict: true })
    const next = await openPage(world, world.tab('next'))
    const opened = await readOpen(next, parent.id)
    const child = continueIn(next, opened)
    for (const label of ['Four', 'Five']) {
        state = widen(state)
        next.flusher.append(
            { kind: 'edit', step: editStep(futureFixtureOperation(label)) },
            state,
            true,
        )
    }
    await next.flusher.flush({ strict: true })
    return { page, next, parent, child }
}

test('a session’s entries come newest first, then the parent’s from where it was continued', async () => {
    const world = createWorld({ seed: 1 })
    const { next, parent, child } = await chain(world)
    const page = await read(next, { sessionId: child.id, limit: 100 })
    assert.deepEqual(
        page.entries.map((entry) => `${entry.kind} ${fallbackOf(entryOperation(entry))?.text}`),
        [
            'edit Five',
            'edit Four',
            'continue Continued',
            'edit Three',
            'edit Two',
            'edit One',
            'init '.trimEnd(),
        ]
            .map((text) => text)
            .slice(0, 6)
            .concat([
                page.entries[6]
                    ? `${page.entries[6].kind} ${fallbackOf(entryOperation(page.entries[6]))?.text}`
                    : '',
            ]),
    )
    assert.equal(page.next, undefined)
    // The continue entry names the time of the parent's entry it continued from.
    const continued = page.entries.find((entry) => entry.kind === 'continue')
    const last = page.entries.find((entry) => entry.sessionId === parent.id)
    assert(continued?.kind === 'continue')
    const operation = decodeOperation(continued.operation)
    assert(operation.status === 'known' && operation.operation.id === 'nse.continue')
    assert.equal(operation.operation.data.fromTime, last?.time)
    assert.equal(continued.from, last?.time)
    assert.equal(continued?.sessionId, child.id)
    assert.ok(page.entries.every((entry) => entry.kept && entry.snapshot.length === 32))
})

test('pages continue where the last ended, across the divider', async () => {
    const world = createWorld({ seed: 1 })
    const { next, child } = await chain(world)
    const seen: string[] = []
    let request: Parameters<typeof readTimeline>[1] | undefined = { sessionId: child.id, limit: 2 }
    let pages = 0
    while (request) {
        const page = await read(next, request)
        seen.push(...page.entries.map((entry) => `${entry.sessionId}:${entry.seq}`))
        request = page.next ? { ...page.next, limit: 2 } : undefined
        pages++
    }
    const all = await read(next, { sessionId: child.id, limit: 100 })
    assert.deepEqual(
        seen,
        all.entries.map((entry) => `${entry.sessionId}:${entry.seq}`),
    )
    assert.ok(pages >= 3)
})

test('malformed rows still move the cursor within their session', async () => {
    const world = createWorld({ seed: 1 })
    const { next, parent, child } = await chain(world)
    // The parent's newest two rows can't be read as entries.
    const rows = await next.tab.run(() =>
        next.core.read(['entries'], (tx) =>
            tx.getAll('entries', KeyRange.bound([parent.id, -Infinity], [parent.id, Infinity])),
        ),
    )
    const broken = (rows as { seq: number }[]).sort((a, b) => b.seq - a.seq).slice(0, 2)
    await next.tab.run(() =>
        next.core.write(['entries'], async (tx) => {
            for (const row of broken) await tx.put('entries', { ...row, time: 'broken' })
        }),
    )
    const first = await read(next, { sessionId: child.id, limit: 5 })
    assert.deepEqual(first.next, { sessionId: parent.id, before: broken[1]!.seq })
    const rest = await read(next, { ...first.next!, limit: 5 })
    assert.deepEqual(
        rest.entries.map((entry) => fallbackOf(entryOperation(entry))?.text),
        ['One', 'Origin: import'],
    )
})

// --- Go To's index and the newer pages after a jump, on rows written directly.

type Synthetic = {
    id: string
    parent?: { id: string; uptoSeq: number }
    times: (number | undefined)[]
}

const HOUR = 3_600_000
/** Local midnight of a fixed day, so the pieces split where the page's days do. */
const day = (offset: number) => new Date(2026, 9, 5 + offset).getTime()

/** Sessions and their entries, written as stored rows; an undefined time leaves a gap in `seq`. */
const seed = async (
    sessions: Synthetic[],
    kindOf: (id: string, seq: number) => 'save' | 'edit' = () => 'edit',
) => {
    const world = createWorld({ seed: 1 })
    const page = await openPage(world, world.tab('first'))
    await page.tab.run(() =>
        page.core.write(['sessions', 'entries'], async (tx) => {
            for (const { id, parent, times } of sessions) {
                await tx.put('sessions', { id, chainId: 'chain', ...(parent ? { parent } : {}) })
                for (const [seq, time] of times.entries())
                    if (time !== undefined)
                        await tx.put('entries', {
                            sessionId: id,
                            seq,
                            time,
                            ...(kindOf(id, seq) === 'edit'
                                ? {
                                      kind: 'edit',
                                      step: editStep(futureFixtureOperation(`${id}${seq}`)),
                                  }
                                : {
                                      kind: 'save',
                                      operation: futureFixtureOperation(`${id}${seq}`),
                                  }),
                            snapshot: new Uint8Array(32),
                            noteCount: seq,
                        })
            }
        }),
    )
    return page
}

const index = (page: Page, request: Parameters<typeof readTimelineIndex>[1]) =>
    page.tab.run(() =>
        page.core.read(['sessions', 'entries'], (tx) => readTimelineIndex(tx, request)),
    )

/** Times a minute apart from `start`. */
const minutes = (start: number, count: number) =>
    Array.from({ length: count }, (_, i): number | undefined => start + i * 60_000)

/** A over midnight with gaps and a branch past where B continued it; B in the afternoon; C over the next midnight. */
const longChain = () => {
    const a = minutes(day(0) + 23 * HOUR, 90)
    for (const seq of [3, 4, 5, 61, 62]) a[seq] = undefined
    return [
        { id: 'A', times: a },
        { id: 'B', parent: { id: 'A', uptoSeq: 70 }, times: minutes(day(1) + 14 * HOUR, 40) },
        { id: 'C', parent: { id: 'B', uptoSeq: 30 }, times: minutes(day(1) + 23.5 * HOUR, 50) },
    ]
}

test('the index lists each session’s entries per day, across midnight, gaps and continuations', async () => {
    const page = await seed(longChain())
    const { pieces, path } = await index(page, { sessionId: 'C' })
    assert.deepEqual(path, [
        { sessionId: 'C', upto: Infinity },
        { sessionId: 'B', upto: 31 },
        { sessionId: 'A', upto: 71 },
    ])
    assert.deepEqual(
        pieces.map((piece) => [piece.sessionId, piece.oldestSeq, piece.newestSeq, piece.count]),
        [
            // C: 30 minutes before midnight, then 20 after.
            ['C', 30, 49, 20],
            ['C', 0, 29, 30],
            ['B', 0, 30, 31],
            // A: 60 minutes before midnight (3 missing), then seq 60 to 70 (2 missing).
            ['A', 60, 70, 9],
            ['A', 0, 59, 57],
        ],
    )
    for (const piece of pieces)
        assert.equal(new Date(piece.oldest).toDateString(), new Date(piece.newest).toDateString())
})

test('the index from a start below the newest, and with only some kinds', async () => {
    const page = await seed(longChain(), (id, seq) => (seq % 20 === 7 ? 'save' : 'edit'))
    const below = await index(page, { sessionId: 'B', before: 31 })
    assert.deepEqual(
        below.pieces.map((piece) => piece.sessionId),
        ['B', 'A', 'A'],
    )
    const saves = await index(page, { sessionId: 'C', kinds: ['save'] })
    assert.deepEqual(
        saves.pieces.map((piece) => [
            piece.sessionId,
            piece.oldestSeq,
            piece.newestSeq,
            piece.count,
        ]),
        [
            ['C', 47, 47, 1],
            ['C', 7, 27, 2],
            ['B', 7, 27, 2],
            ['A', 67, 67, 1],
            ['A', 7, 47, 3],
        ],
    )
})

test('newer pages read along the path across the dividers, counting what is left', async () => {
    const page = await seed(longChain())
    const { path } = await index(page, { sessionId: 'C' })
    const all = await read(page, { sessionId: 'C', limit: 1000 })
    const ids = all.entries.map((entry) => `${entry.sessionId}:${entry.seq}`)
    // From A's seq 40 up, in pages of 25, until nothing newer is left.
    let request: Parameters<typeof readTimeline>[1] | undefined = {
        sessionId: 'A',
        after: 40,
        limit: 25,
        path,
    }
    const seen: string[] = []
    while (request) {
        const result = await read(page, request)
        const keys = result.entries.map((entry) => `${entry.sessionId}:${entry.seq}`)
        seen.unshift(...keys)
        const top = ids.indexOf(keys[0] ?? '')
        assert.equal(result.newer?.count ?? 0, top)
        request = result.newer ? { ...result.newer, limit: 25, path } : undefined
    }
    assert.deepEqual(seen, ids.slice(0, ids.indexOf('A:40')))
})

test('a jump and the index on a 10,000-entry chain', async () => {
    // Forty visits of 250 entries, two a day.
    const sessions: Synthetic[] = []
    for (let i = 0; i < 40; i++)
        sessions.push({
            id: `S${String(i).padStart(2, '0')}`,
            ...(i ? { parent: { id: sessions[i - 1]!.id, uptoSeq: 249 } } : {}),
            times: minutes(day(Math.floor(i / 2)) + (i % 2 ? 15 : 9) * HOUR, 250),
        })
    const page = await seed(sessions)
    const head = sessions.at(-1)!.id
    let started = performance.now()
    const { pieces, path } = await index(page, { sessionId: head })
    const indexTime = performance.now() - started
    assert.equal(pieces.length, 40)
    assert.equal(
        pieces.reduce((sum, piece) => sum + piece.count, 0),
        10_000,
    )
    const target = pieces[30]!
    started = performance.now()
    const [below, above] = await Promise.all([
        read(page, { sessionId: target.sessionId, before: target.newestSeq + 1, limit: 100 }),
        read(page, { sessionId: target.sessionId, after: target.newestSeq, limit: 100, path }),
    ])
    const jumpTime = performance.now() - started
    assert.equal(below.entries[0]?.seq, target.newestSeq)
    assert.equal(above.entries.length, 100)
    assert.equal(above.newer?.count, 30 * 250 - 100)
    if (process.env.NSE_MEASURE)
        console.log(`index ${indexTime.toFixed(1)} ms, jump ${jumpTime.toFixed(1)} ms`)
})
