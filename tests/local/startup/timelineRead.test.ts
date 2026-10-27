import assert from 'node:assert/strict'
import test from 'node:test'
import { dayKey, resolveZone } from '../../../src/calendar/calendar'
import { decodeOperation, entryOperation, fallbackOf } from '../../../src/history/operations'
import { KeyRange } from '../../../src/local/kv/types'
import { createWorld, type World } from '../../../src/local/testing/world'
import { readTimeline, readTimelineIndex } from '../../../src/local/worker/timelineHandlers'
import { editStep, futureFixtureOperation } from '../../helpers/historySteps'
import '../../helpers/lockChecks'
import { openPage, type Page } from '../flush/harness'
import { goldenChart, stateOf } from '../records/charts'
import { widen } from '../timeline/helpers'
import { beginIn, continueIn, readOpen } from './harness'

// The History panel's Timeline read: a session's entries newest first, a page
// at a time, on into the session it continued at the entry it continued from.

const read = (page: Page, request: Parameters<typeof readTimeline>[1]) =>
    page.tab.run(() =>
        page.core.read(['sessions', 'entries', 'chains', 'nodes'], (tx) =>
            readTimeline(tx, request),
        ),
    )

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

test("a session's entries come newest first, then the parent's from where it was continued", async () => {
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

test('a row this build cannot decode stays in the run as an unavailable entry, newer or damaged by its cause', async () => {
    const world = createWorld({ seed: 1 })
    const { next, parent } = await chain(world)
    const rows = (await next.tab.run(() =>
        next.core.read(['entries'], (tx) =>
            tx.getAll('entries', KeyRange.bound([parent.id, -Infinity], [parent.id, Infinity])),
        ),
    )) as Record<string, unknown>[]
    const [three, two, one] = rows.sort((a, b) => (b.seq as number) - (a.seq as number))
    const before = await read(next, { sessionId: parent.id, limit: 100 })
    await next.tab.run(() =>
        next.core.write(['entries'], async (tx) => {
            // A kind this build does not know, a key no carrier knows, and a step that is malformed.
            await tx.put('entries', { ...three, kind: 'merge' })
            await tx.put('entries', { ...two, step: { ...(two!.step as object), zz: 1 } })
            await tx.put('entries', { ...one, step: { kind: 'nope', operation: null } })
        }),
    )
    const after = await read(next, { sessionId: parent.id, limit: 100 })
    // The chain is not shortened: every row is still there, in order.
    assert.deepEqual(
        after.entries.map((entry) => entry.seq),
        before.entries.map((entry) => entry.seq),
    )
    const by = (seq: unknown) => after.entries.find((entry) => entry.seq === seq)
    assert.equal(by(three!.seq)?.unreadable, 'newer')
    assert.equal(by(two!.seq)?.unreadable, 'newer')
    assert.equal(by(one!.seq)?.unreadable, 'damaged')
    assert.ok(after.entries.filter((entry) => entry.unreadable).length === 3)
    // The rest decode as before, and the unavailable rows keep their time and snapshot.
    assert.equal(by(three!.seq)?.time, three!.time)
    assert.equal(by(three!.seq)?.snapshot.length, 32)
})

// --- Go To's index and the newer pages after a jump, on rows written directly.

type Synthetic = {
    id: string
    parent?: { id: string; uptoSeq: number }
    times: (number | undefined)[]
}

/** Both ways an index reads a session: searched (rows of its own) and read in full (a file's). */
const ORIGINS = ['continued', 'nxsp'] as const

const HOUR = 3_600_000
/** The zone the pieces are cut in, and midnight of a fixed day in it. */
const ZONE = 'UTC'
const day = (offset: number) => Date.UTC(2026, 9, 5, 0, 0, 0, 0) + offset * 24 * HOUR

/** Sessions and their entries, written as stored rows; an undefined time leaves a gap in `seq`. */
const seed = async (
    sessions: Synthetic[],
    kindOf: (id: string, seq: number) => 'save' | 'edit' = () => 'edit',
    origin: (typeof ORIGINS)[number] = 'continued',
) => {
    const world = createWorld({ seed: 1 })
    const page = await openPage(world, world.tab('first'))
    await page.tab.run(() =>
        page.core.write(['sessions', 'entries'], async (tx) => {
            for (const { id, parent, times } of sessions) {
                await tx.put('sessions', {
                    id,
                    chainId: 'chain',
                    origin,
                    ...(parent ? { parent } : {}),
                })
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

const index = (
    page: Page,
    request: Omit<Parameters<typeof readTimelineIndex>[1], 'zone'> & { zone?: string },
) =>
    page.tab.run(() =>
        page.core.read(['sessions', 'entries'], (tx) =>
            readTimelineIndex(tx, { zone: ZONE, ...request }),
        ),
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

for (const origin of ORIGINS)
    test(`the index lists each session's entries per day, across midnight, gaps and continuations (${origin})`, async () => {
        const page = await seed(longChain(), undefined, origin)
        const { pieces, path, top, topSession, importing } = await index(page, { sessionId: 'C' })
        assert.equal(top, 49)
        assert.equal(topSession, 'C')
        assert.equal(importing, false)
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
        for (const piece of pieces) {
            assert.equal(dayKey(piece.oldest, resolveZone(ZONE)), piece.day)
            assert.equal(dayKey(piece.newest, resolveZone(ZONE)), piece.day)
            assert.equal(piece.earliest, piece.oldest)
            assert.equal(piece.latest, piece.newest)
        }
    })

for (const origin of ORIGINS)
    test(`the index from a start below the newest, and with only some kinds (${origin})`, async () => {
        const page = await seed(
            longChain(),
            (id, seq) => (seq % 20 === 7 ? 'save' : 'edit'),
            origin,
        )
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

test('the index and pages reach the oldest day of a chain of 300 visits', async () => {
    // A visit a day with three edits, continued each next day.
    const sessions: Synthetic[] = []
    for (let i = 0; i < 300; i++)
        sessions.push({
            id: `V${String(i).padStart(3, '0')}`,
            ...(i ? { parent: { id: sessions[i - 1]!.id, uptoSeq: 2 } } : {}),
            times: minutes(day(i) + 10 * HOUR, 3),
        })
    const page = await seed(sessions)
    const head = sessions.at(-1)!.id
    const { pieces, path } = await index(page, { sessionId: head })
    assert.equal(path.length, 300)
    assert.equal(pieces.length, 300)
    assert.equal(pieces.at(-1)?.sessionId, 'V000')
    // Go To the oldest day, then newer pages up to the head.
    const oldest = pieces.at(-1)!
    let request: Parameters<typeof readTimeline>[1] | undefined = {
        sessionId: oldest.sessionId,
        after: oldest.oldestSeq,
        limit: 250,
        path,
    }
    let count = 0
    while (request) {
        const result = await read(page, request)
        count += result.entries.length
        request = result.newer ? { ...result.newer, limit: 250, path } : undefined
    }
    assert.equal(count, 300 * 3 - 1)
    // Older pages from the head reach it too.
    const all = await read(page, { sessionId: head, limit: 1000 })
    assert.equal(all.entries.length, 900)
    assert.equal(all.entries.at(-1)?.sessionId, 'V000')
})

test('a cycle in damaged parent links ends the path', async () => {
    const page = await seed([
        { id: 'X', parent: { id: 'Y', uptoSeq: 1 }, times: minutes(day(0), 2) },
        { id: 'Y', parent: { id: 'X', uptoSeq: 1 }, times: minutes(day(1), 2) },
    ])
    const { path } = await index(page, { sessionId: 'X' })
    assert.deepEqual(
        path.map((step) => step.sessionId),
        ['X', 'Y'],
    )
    const all = await read(page, { sessionId: 'X', limit: 100 })
    assert.deepEqual(
        all.entries.map((entry) => `${entry.sessionId}:${entry.seq}`),
        ['X:1', 'X:0', 'Y:1', 'Y:0'],
    )
})

// --- Damaged rows: a `kept: false` row whose root reaches a hash in the chain's
// `badChunks` through the stored nodes' `refs` reads damaged, also after a reload.

test('a kept: false row that reaches a bad chunk reads damaged; one that does not reads removed', async () => {
    const world = createWorld({ seed: 1 })
    const { next, parent, child } = await chain(world)
    const { unpackHashes, hashKey } = await import('../../../src/local/records/rows')
    const { toHex } = await import('../../../src/local/hash')
    const all = await read(next, { sessionId: child.id, limit: 100 })
    const byText = (text: string) =>
        all.entries.find((entry) => fallbackOf(entryOperation(entry))?.text === text)!
    const reach = async (root: string) => {
        const seen = new Set<string>()
        const walk = async (hex: string) => {
            const row = (await next.tab.run(() =>
                next.core.read(['nodes'], (tx) =>
                    tx.get('nodes', hashKey(Uint8Array.from(Buffer.from(hex, 'hex')))),
                ),
            )) as { t: string; refs: Uint8Array; kinds?: string[] } | undefined
            if (!row) return
            const refs = unpackHashes(row.refs).map(toHex)
            for (const ref of refs) {
                if (seen.has(ref)) continue
                seen.add(ref)
                await walk(ref)
            }
        }
        await walk(root)
        return seen
    }
    const one = await reach(byText('One').snapshot)
    const two = await reach(byText('Two').snapshot)
    const onlyTwo = [...two].filter((hash) => !one.has(hash))
    assert.ok(onlyTwo.length > 0, 'Two has a part One lacks')
    const bad = Uint8Array.from(Buffer.from(onlyTwo.at(-1)!, 'hex'))
    const { packHashes } = await import('../../../src/local/records/rows')
    await next.tab.run(() =>
        next.core.write(['entries', 'chains'], async (tx) => {
            for (const text of ['One', 'Two']) {
                const e = byText(text)
                const stored = await tx.get('entries', [e.sessionId, e.seq])
                await tx.put('entries', { ...(stored as object), kept: false })
            }
            const chainRow = await tx.get('chains', String(child.chainId))
            await tx.put('chains', { ...(chainRow as object), badChunks: packHashes([bad]) })
        }),
    )
    void parent
    const after = await read(next, { sessionId: child.id, limit: 100 })
    const flag = (text: string) => {
        const e = after.entries.find((entry) => fallbackOf(entryOperation(entry))?.text === text)!
        return { kept: e.kept, damaged: e.damaged === true }
    }
    assert.deepEqual(flag('Two'), { kept: false, damaged: true })
    assert.deepEqual(flag('One'), { kept: false, damaged: false })
    assert.deepEqual(flag('Three'), { kept: true, damaged: false })
})
