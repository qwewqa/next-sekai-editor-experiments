import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveZone } from '../../../src/calendar/calendar'
import type { PieceEntry } from '../../../src/calendar/pieces'
import { captureName } from '../../../src/history/operations'
import { DB_NAME } from '../../../src/local/db'
import { MemoryStorage } from '../../../src/local/journal/store'
import type { KvTx } from '../../../src/local/kv/types'
import { executePlan, planNxsp } from '../../../src/local/nxsp'
import type { OpenStoreRequest } from '../../../src/local/open/importWrite'
import { stateBatch } from '../../../src/local/stateBatch'
import { checkStored } from '../../../src/local/testing/invariants'
import { createWorld, type World } from '../../../src/local/testing/world'
import { openHandlers } from '../../../src/local/worker/openHandlers'
import { startupHandlers } from '../../../src/local/worker/startupHandlers'
import {
    createIndexMemo,
    readTimeline,
    readTimelineIndex,
    type IndexMemo,
    type TimelineIndexRequest,
} from '../../../src/local/worker/timelineHandlers'
import {
    editStep,
    futureFixtureOperation,
    nativeOperation,
    originOperation,
} from '../../helpers/historySteps'
import '../../helpers/lockChecks'
import { brutePieces } from '../../helpers/piecesBrute'
import { openPage, rows, testId, type Page } from '../flush/harness'
import { append, beginSession, openJournalPage, replayAll } from '../journal/harness'
import { fresh } from '../nxsp/chain'
import { goldenChart, stateOf } from '../records/charts'
import { beginIn, continueIn, readOpen, resumeIn } from '../startup/harness'
import { widen } from './helpers'

// Spec-C invariant 7: the storage worker's index (`readTimelineIndex`) equals the pieces of the entries the
// Timeline lists, for every session a real writer makes: new, import, continued, forked, migrated,
// journal, opened from a file (with shuffled times and a changed level), replaced, and an unknown
// origin. The oracle is the Timeline's own read (`readTimeline`) cut into pieces by a plain
// restatement of the definition, in six zones, with and without the Saves filter. One worker (one
// memo) answers All, then Saves, then All again, and again after writes that change what a memo holds.

/** A time `days` after Oct 5 2026 (UTC) at `hours`:`minutes`. */
const at = (days: number, hours: number, minutes = 0) => Date.UTC(2026, 9, 5 + days, hours, minutes)

const ZONES = [
    'UTC',
    'America/New_York',
    'Asia/Kathmandu',
    'Pacific/Kiritimati',
    'Pacific/Pago_Pago',
    'Europe/London',
]
const SAVES = ['save', 'export']

const DEVICE = { id: 'device-1', label: 'Web (Chrome)' }
const SAVE_OPERATION = nativeOperation(
    { id: 'nse.file.save', data: { file: captureName('coconut.nxsp'), delivery: 'file' } },
    'Saved coconut.nxsp',
)

/** A worker's index read, with the number of whole-session reads it made. */
class Reader {
    readonly memo: IndexMemo = createIndexMemo()
    /** `getAll` calls of the last index read: a session read in full. */
    linear = 0
    /** Rows those reads returned. */
    rowsRead = 0

    constructor(
        readonly world: World,
        readonly page: Page,
    ) {}

    private counted(tx: KvTx): KvTx {
        return new Proxy(tx, {
            get: (target, key) => {
                const value = Reflect.get(target, key) as unknown
                if (typeof value !== 'function') return value
                if (key === 'getAll')
                    return async (...args: unknown[]) => {
                        this.linear++
                        const found = (await (value as (...a: unknown[]) => unknown).apply(
                            target,
                            args,
                        )) as unknown[]
                        this.rowsRead += found.length
                        return found
                    }
                return (value as (...a: unknown[]) => unknown).bind(target)
            },
        })
    }

    index(request: TimelineIndexRequest) {
        this.linear = 0
        this.rowsRead = 0
        return this.page.tab.run(() =>
            this.page.core.read(['sessions', 'entries'], (tx) =>
                readTimelineIndex(this.counted(tx), request, this.memo),
            ),
        )
    }

    timeline(request: Parameters<typeof readTimeline>[1]) {
        return this.page.tab.run(() =>
            this.page.core.read(['sessions', 'entries', 'chains', 'nodes'], (tx) =>
                readTimeline(tx, request),
            ),
        )
    }

    /** Every stored session id. */
    sessions() {
        return [...rows(this.world, 'sessions').keys()]
    }

    /** The index for a request equals the pieces of the Timeline's own list; returns the result. */
    async expectEquivalent(request: TimelineIndexRequest, label: string) {
        const result = await this.index(request)
        const read = await this.timeline({
            sessionId: request.sessionId,
            ...(request.before === undefined ? {} : { before: request.before }),
            limit: 1_000_000,
        })
        const list: PieceEntry[] = read.entries.map((entry) => ({
            sessionId: entry.sessionId,
            seq: entry.seq,
            time: entry.time,
            kind: entry.kind,
        }))
        const expected = brutePieces(list, resolveZone(request.zone), request.kinds)
        assert.deepEqual(result.pieces, expected, label)
        const newest = expected[0]
        assert.equal(
            result.top,
            newest?.sessionId === request.sessionId ? newest.newestSeq : undefined,
            `${label}: top`,
        )
        assert.equal(result.topSession, request.sessionId, `${label}: topSession`)
        return result
    }

    /** Every session as a head (and just below its newest entry), in every zone and both filters. */
    async expectAll(label: string, order: ('all' | 'saves')[] = ['all', 'saves', 'all']) {
        for (const filter of order)
            for (const zone of ZONES)
                for (const id of this.sessions()) {
                    const kinds = filter === 'saves' ? SAVES : undefined
                    const base = { sessionId: id, zone, ...(kinds ? { kinds } : {}) }
                    await this.expectEquivalent(base, `${label} ${filter} ${zone} ${id}`)
                    const session = rows(this.world, 'sessions').get(id)
                    const last = session?.lastSeq
                    if (typeof last === 'number' && last > 2)
                        await this.expectEquivalent(
                            { ...base, before: last },
                            `${label} ${filter} ${zone} ${id} before ${last}`,
                        )
                }
    }
}

const expectWhole = (world: World) =>
    assert.deepEqual(checkStored(world.memory, world.sessionOptions), [])

// --- Sessions the flusher writes: new, import, continued, forked.

const flusherWorld = async () => {
    const world = createWorld({ seed: 11 })
    let wall = at(0, 21)
    const first = await openPage(world, world.tab('first'), { now: () => wall })
    let state = stateOf(goldenChart())
    let n = 0
    const edit = async (page: Page, label: string, time: number) => {
        wall = time
        state = widen(state, n++)
        page.flusher.append(
            { kind: 'edit', step: editStep(futureFixtureOperation(label)) },
            state,
            true,
        )
        await page.flusher.flush({ strict: true })
    }
    const save = async (page: Page, time: number) => {
        wall = time
        const reservation = page.flusher.reserveSave()!
        await page.flusher.endSave(reservation, {
            wall: reservation.wall,
            operation: SAVE_OPERATION,
            state,
            revisionId: `rev-${n++}`,
            device: DEVICE,
            appVersion: '0.6.0',
        })
    }
    // A new session across two midnights, with a Save.
    const created = beginIn(first, state, 'new')
    await first.flusher.flush({ strict: true })
    await edit(first, 'A1', at(0, 22, 30))
    await edit(first, 'A2', at(1, 0, 30))
    await save(first, at(1, 6))
    await edit(first, 'A3', at(1, 13))
    await edit(first, 'A4', at(2, 3))
    // An imported session of another chart.
    wall = at(2, 12)
    const imported = beginIn(first, stateOf(goldenChart()), 'import')
    await first.flusher.flush({ strict: true })
    await edit(first, 'B1', at(2, 23, 30))
    await edit(first, 'B2', at(3, 0, 20))
    // A later tab continues the first session, then edits across a midnight.
    const next = await openPage(world, world.tab('next'), { now: () => wall })
    wall = at(4, 9)
    const read = await readOpen(next, created.id)
    const continued = continueIn(next, read)
    await next.flusher.flush({ strict: true })
    await edit(next, 'C1', at(4, 23, 10))
    await save(next, at(5, 0, 5))
    await edit(next, 'C2', at(5, 15))
    // A fork of the continuation with entries of its own, and one without any.
    const third = await openPage(world, world.tab('third'), { now: () => wall })
    wall = at(6, 8)
    const forkRead = await readOpen(third, continued.id)
    const withEntries = continueIn(third, forkRead, { asFork: true })
    await third.flusher.flush({ strict: true })
    await edit(third, 'D1', at(6, 23, 45))
    await edit(third, 'D2', at(7, 1))
    const fourth = await openPage(world, world.tab('fourth'), { now: () => wall })
    wall = at(8, 10)
    const bareRead = await readOpen(fourth, continued.id)
    const bare = continueIn(fourth, bareRead, { asFork: true })
    // A continuation is stored from its first own entry: this fork holds one beside its divider.
    await edit(fourth, 'E1', at(8, 11))
    return {
        world,
        page: first,
        pages: { first, next, third, fourth },
        edit,
        save,
        ids: { created, imported, continued, withEntries, bare },
    }
}

test('the index equals the Timeline’s pieces for new, imported, continued and forked sessions', async () => {
    const { world, page, ids } = await flusherWorld()
    expectWhole(world)
    const reader = new Reader(world, page)
    assert.equal(reader.sessions().length, 5)
    await reader.expectAll('flusher')
    // A Save is a step with a divider-free piece of its own kind; the Saves filter found them.
    const saves = await reader.index({
        sessionId: ids.continued.id,
        zone: 'UTC',
        kinds: SAVES,
    })
    assert.deepEqual(
        saves.pieces.map((piece) => [piece.sessionId === ids.continued.id, piece.count]),
        [
            [true, 1],
            [false, 1],
        ],
    )
})

test('own sessions are searched; a filter or a file’s rows are read in full, once, through the memo', async () => {
    const { world, page, ids } = await flusherWorld()
    const reader = new Reader(world, page)
    const request = { sessionId: ids.continued.id, zone: 'America/New_York' }
    // new → continued → the first session: all of own rows, no whole-session read.
    await reader.expectEquivalent(request, 'all')
    assert.equal(reader.linear, 0)
    // The Saves filter reads every session in full the first time and from the memo after.
    const saves = { ...request, kinds: SAVES }
    await reader.expectEquivalent(saves, 'saves')
    const first = reader.linear
    assert.equal(first, 2)
    await reader.expectEquivalent(saves, 'saves again')
    assert.equal(reader.linear, 0)
    // Another zone is another memo entry.
    await reader.expectEquivalent({ ...saves, zone: 'UTC' }, 'saves in UTC')
    assert.equal(reader.linear, 2)
    await reader.expectEquivalent(request, 'all again')
    assert.equal(reader.linear, 0)
})

test('an own session with an import pending is read in full (P3’s guard)', async () => {
    const { world, page, ids } = await flusherWorld()
    const reader = new Reader(world, page)
    const request = { sessionId: ids.created.id, zone: 'UTC' }
    await reader.expectEquivalent(request, 'before')
    assert.equal(reader.linear, 0)
    await page.tab.run(() =>
        page.core.write(['sessions'], async (tx) => {
            const row = (await tx.get('sessions', ids.created.id)) as Record<string, unknown>
            await tx.put('sessions', { ...row, importPending: true })
        }),
    )
    const result = await reader.expectEquivalent(request, 'pending')
    assert.equal(reader.linear, 1)
    assert.equal(result.importing, true)
    // It is unpended again: searched again, and not importing.
    await page.tab.run(() =>
        page.core.write(['sessions'], async (tx) => {
            const row = (await tx.get('sessions', ids.created.id)) as Record<string, unknown>
            const rest = { ...row }
            delete rest.importPending
            await tx.put('sessions', rest)
        }),
    )
    const done = await reader.expectEquivalent(request, 'after')
    assert.equal(reader.linear, 0)
    assert.equal(done.importing, false)
})

test('an unknown origin is a file’s: read in full, and the same pieces', async () => {
    const { world, page, ids } = await flusherWorld()
    for (const origin of ['quantum', undefined, 7]) {
        await page.tab.run(() =>
            page.core.write(['sessions'], async (tx) => {
                const row = (await tx.get('sessions', ids.created.id)) as Record<string, unknown>
                const rest = { ...row }
                delete rest.origin
                await tx.put('sessions', origin === undefined ? rest : { ...rest, origin })
            }),
        )
        const reader = new Reader(world, page)
        const result = await reader.expectEquivalent(
            { sessionId: ids.created.id, zone: 'Asia/Kathmandu' },
            `origin ${String(origin)}`,
        )
        assert.ok(reader.linear >= 1)
        assert.equal(result.importing, false)
    }
})

// --- The memo: an append extends it; a change it cannot see through is read in full.

test('a head read in full extends by the rows its own flush adds, and agrees with a cold read', async () => {
    const { world, page, pages, edit, ids } = await flusherWorld()
    // An unknown origin is a file's, so the head takes the memo path.
    await page.tab.run(() =>
        page.core.write(['sessions'], async (tx) => {
            const row = (await tx.get('sessions', ids.bare.id)) as Record<string, unknown>
            await tx.put('sessions', { ...row, origin: 'future' })
        }),
    )
    const reader = new Reader(world, page)
    const request = { sessionId: ids.bare.id, zone: 'UTC' }
    await reader.expectEquivalent(request, 'warm')
    assert.ok(reader.linear >= 1)
    await reader.expectEquivalent(request, 'hit')
    assert.equal(reader.linear, 0)
    for (const [i, time] of [at(8, 11), at(8, 23, 30), at(9, 0, 30), at(9, 5)].entries()) {
        await edit(pages.fourth, `F${i}`, time)
        // The parent's pieces stay in the memo: only the head's new rows are read.
        const result = await reader.expectEquivalent(request, `after flush ${i}`)
        // One ranged read of just the row the flush added: the memo extended.
        assert.equal(reader.linear, 1, `${reader.linear} reads`)
        assert.equal(reader.rowsRead, 1, `${reader.rowsRead} rows read`)
        assert.equal(result.top, rows(world, 'sessions').get(ids.bare.id)?.lastSeq)
        const cold = await new Reader(world, page).index(request)
        assert.deepEqual(result, cold)
    }
    expectWhole(world)
})

test('writes under a memo: a late row, a removed row, a flipped kept flag and a deleted parent', async () => {
    const { world, page, ids } = await flusherWorld()
    const head = ids.imported.id
    await page.tab.run(() =>
        page.core.write(['sessions'], async (tx) => {
            const row = (await tx.get('sessions', head)) as Record<string, unknown>
            await tx.put('sessions', { ...row, origin: 'nxsp' })
        }),
    )
    const reader = new Reader(world, page)
    const request = { sessionId: head, zone: 'Pacific/Kiritimati' }
    const check = async (label: string) => {
        const warm = await reader.expectEquivalent(request, label)
        const cold = await new Reader(world, page).index(request)
        assert.deepEqual(warm, cold, label)
    }
    const write = (change: (tx: KvTx, session: Record<string, number>) => Promise<void>) =>
        page.tab.run(() =>
            page.core.write(['sessions', 'entries'], async (tx) => {
                const session = (await tx.get('sessions', head)) as Record<string, unknown>
                await change(tx, session as Record<string, number>)
            }),
        )
    const rowAt = async (tx: KvTx, seq: number) =>
        (await tx.get('entries', [head, seq])) as Record<string, unknown>
    await check('warm')
    const lastSeq = (rows(world, 'sessions').get(head)?.lastSeq as number) ?? 0
    assert.ok(lastSeq >= 3)

    // A row appended above lastSeq, as every writer adds one: the counters move and the memo extends.
    await write(async (tx, session) => {
        await tx.put('entries', { ...(await rowAt(tx, 1)), seq: lastSeq + 1, time: at(40, 8) })
        await tx.put('sessions', {
            ...session,
            lastSeq: lastSeq + 1,
            entryCount: session.entryCount! + 1,
        })
    })
    await check('appended')
    assert.equal((await reader.index(request)).top, lastSeq + 1)

    // A recovered row above it, then a kept flag flipped without any counter moving (it changes no piece).
    await write(async (tx, session) => {
        await tx.put('entries', {
            ...(await rowAt(tx, 1)),
            seq: lastSeq + 2,
            kind: 'recovered',
            time: at(41, 8),
        })
        await tx.put('sessions', {
            ...session,
            lastSeq: lastSeq + 2,
            entryCount: session.entryCount! + 1,
        })
    })
    await check('recovered')
    await write(async (tx) => {
        await tx.put('entries', { ...(await rowAt(tx, 2)), kept: false })
    })
    await check('kept flipped')
    assert.equal(reader.linear, 0)

    // A row removed from the middle, the counter moved as a per-row delete must: a read in full.
    await write(async (tx, session) => {
        await tx.delete('entries', [head, 2])
        await tx.put('sessions', { ...session, entryCount: session.entryCount! - 1 })
    })
    await check('removed')
    assert.ok(reader.linear >= 1)
    // A late row filling the hole, with a time out of order: the rows above the memo's top are
    // the same, the counter is not, so it reads in full.
    await write(async (tx, session) => {
        await tx.put('entries', { ...(await rowAt(tx, 1)), seq: 2, time: at(3, 5) })
        await tx.put('sessions', { ...session, entryCount: session.entryCount! + 1 })
    })
    await check('late row')
    assert.ok(reader.linear >= 1)

    // The parent deleted whole (rows and session row), as a GC does: the path ends there.
    const child = ids.continued.id
    const parent = ids.created.id
    const childRequest = { sessionId: child, zone: 'Europe/London', kinds: SAVES }
    await reader.expectEquivalent(childRequest, 'child warm')
    await page.tab.run(() =>
        page.core.write(['sessions', 'entries'], async (tx) => {
            const all = await tx.getAll(
                'entries',
                (await import('../../../src/local/kv/types')).KeyRange.bound(
                    [parent, -Infinity],
                    [parent, Infinity],
                ),
            )
            for (const row of all as { seq: number }[])
                await tx.delete('entries', [parent, row.seq])
            await tx.delete('sessions', parent)
        }),
    )
    await reader.expectEquivalent(childRequest, 'parent deleted')
})

// --- Sessions opened from a file: shuffled times, a changed level, Replace, an import in progress.

const ids = { chainId: 'chain-1', sessionId: 'session-1', docId: 'doc', lineageId: 'lineage' }

const storeRequest = (id: string, extra: Partial<OpenStoreRequest> = {}): OpenStoreRequest => ({
    id,
    ids,
    chain: {
        name: 'Coconut (Master)',
        file: { name: 'coconut.nxsp', event: 'opened', options: { history: true, bgm: true } },
    },
    operations: {
        opened: originOperation('import'),
        changedOutside: nativeOperation(
            { id: 'nse.externalChange', data: {} },
            'Changed outside the editor',
        ),
    },
    wall: at(12, 8),
    appVersion: '0.6.0',
    ...extra,
})

/** The shared chain with its four entries stamped at `times` (in the file's order). */
const fileWith = async (times: number[]) => {
    const chain = fresh()
    const history = chain.input.history!
    const stamped = {
        ...chain.input,
        history: {
            ...history,
            entries: history.entries.map((each, i) => ({ ...each, time: times[i]! })),
        },
    }
    return executePlan(planNxsp(stamped).plan, new Map())
}

const openedWorld = async () => {
    const world = createWorld({ seed: 21 })
    const page = await openPage(world, world.tab('a'))
    const context = { core: page.core, test: true, emit: () => undefined }
    const open = openHandlers(context, page.tab.waiter)
    const run = <T>(fn: () => Promise<T>) => page.tab.run(fn)
    return { world, page, open, run }
}

/** The file's times: out of order and over several days, as a file from a device with another clock. */
const SHUFFLED = [at(2, 9), at(0, 22), at(3, 1), at(0, 23, 30)]

const openFile = async (
    s: Awaited<ReturnType<typeof openedWorld>>,
    sessionId: string,
    times: number[],
    extra: Partial<OpenStoreRequest> = {},
    finish = true,
) => {
    const file = await fileWith(times)
    const reply = await s.run(() => s.open.openRead(file))
    if (reply.kind !== 'nxsp') throw new Error('not nxsp')
    const stored = await s.run(() =>
        s.open.openStore(
            storeRequest(reply.id, {
                ids: { ...ids, chainId: `chain-${sessionId}`, sessionId },
                ...extra,
            }),
        ),
    )
    if (stored.kind !== 'stored') throw new Error('not stored')
    const batches = async (from: number, to: number) => {
        for (let n = from; n < to; n++) await s.run(() => s.open.openBatch({ id: reply.id, n }))
    }
    if (finish) await batches(0, stored.batches ?? 0)
    return { reply, stored, batches }
}

test('files opened with shuffled times, a changed level, Replace and an import under way: the same pieces', async () => {
    const s = await openedWorld()
    const reader = new Reader(s.world, s.page)
    // Head stored, import under way: importPending, so read in full (and not the whole file yet).
    const plain = await openFile(s, 'plain', SHUFFLED, {}, false)
    const pending = await reader.expectEquivalent({ sessionId: 'plain', zone: 'UTC' }, 'pending')
    assert.equal(pending.importing, true)
    assert.ok(reader.linear >= 1)
    await reader.expectAll('pending', ['all'])
    // The batches land below the head's own rows: the memo reads again.
    await plain.batches(0, plain.stored.batches ?? 0)
    const done = await reader.expectEquivalent({ sessionId: 'plain', zone: 'UTC' }, 'done')
    assert.equal(done.importing, false)
    // The same file again with a changed level (an "edited outside" row), and as Replace.
    const level = stateBatch(widen(stateOf(goldenChart()), 3))
    await openFile(s, 'changed', SHUFFLED, { level })
    await openFile(s, 'replaced', SHUFFLED, { origin: 'replaced', level })
    await openFile(s, 'ordered', [at(0, 20), at(0, 23), at(1, 2), at(1, 5)])
    expectWhole(s.world)
    const origins = new Map(
        [...rows(s.world, 'sessions').entries()].map(([id, row]) => [id, row.origin]),
    )
    assert.deepEqual([...origins.keys()].sort(), ['changed', 'ordered', 'plain', 'replaced'])
    assert.equal(origins.get('replaced'), 'replaced')
    assert.equal(origins.get('plain'), 'nxsp')
    await reader.expectAll('opened')

    // The page edits the opened session and the memo extends; All → Saves → All again.
    const tab = await openPage(s.world, s.world.tab('b'), { now: () => at(14, 9) })
    const read = await readOpen(tab, 'changed')
    resumeIn(tab, read)
    let state = stateOf(goldenChart())
    for (const [i, label] of ['E1', 'E2'].entries()) {
        state = widen(state, i + 5)
        tab.flusher.append(
            { kind: 'edit', step: editStep(futureFixtureOperation(label)) },
            state,
            true,
        )
        await tab.flusher.flush({ strict: true })
    }
    await reader.expectAll('after edits', ['all', 'saves', 'all'])
    assert.equal(DB_NAME.length > 0, true)
})

test('an opened session’s pieces keep the file’s times in any order: a day listed again where its rows come back', async () => {
    const s = await openedWorld()
    const reader = new Reader(s.world, s.page)
    await openFile(s, 'shuffled', SHUFFLED)
    const result = await reader.expectEquivalent({ sessionId: 'shuffled', zone: 'UTC' }, 'shuffled')
    // Day 0, day 3, day 2, day 0 (the file’s order, newest seq first), then the open’s rows today.
    const days = result.pieces.map((piece) => piece.day)
    assert.equal(new Set(days).size < days.length, true)
})

// --- Journal and migration.

test('a journal recovery, a replayed journal and a migrated auto save give the same pieces', async () => {
    const world = createWorld({ seed: 31 })
    const storage = new MemoryStorage()
    const journaled = await openJournalPage(world, 'a', storage, {}, {}, { now: () => at(0, 21) })
    const a = stateOf(goldenChart())
    const session = beginSession(journaled, a)
    await journaled.flusher.flush({ strict: true })
    append(
        journaled,
        { kind: 'edit', step: editStep(futureFixtureOperation('Changed note')) },
        widen(a),
    )
    await journaled.flusher.flush({ strict: true })
    append(
        journaled,
        { kind: 'edit', step: editStep(futureFixtureOperation('Moved notes')) },
        widen(a, 1),
    )
    // The hide: the journal, then a flush that never lands. Another tab applies it.
    assert.equal(journaled.writer.write(), true)
    journaled.tab.kill()
    const applied = await replayAll(world, storage)
    assert.equal(applied.outcomes[0]?.kind, 'applied')

    // A second journal whose session was removed: a recovery session of a new chain.
    const second = await openJournalPage(world, 'b', storage, {}, {}, { now: () => at(2, 8) })
    const other = beginSession(second, stateOf(goldenChart()))
    await second.flusher.flush({ strict: true })
    append(
        second,
        { kind: 'edit', step: editStep(futureFixtureOperation('Changed BPM')) },
        widen(a, 2),
    )
    assert.equal(second.writer.write(), true)
    second.tab.kill()
    const sweeper = world.tab('sweeper')
    const { workerCore } = await import('../flush/harness')
    const core = workerCore(world, sweeper)
    await sweeper.run(() => core.start())
    await sweeper.run(() =>
        core.write(['chains'], async (tx) => {
            const chain = (await tx.get('chains', other.chainId)) as Record<string, unknown>
            await tx.put('chains', { ...chain, deleting: { at: 1 } })
        }),
    )
    const recovered = await replayAll(world, storage, 'next2')
    assert.ok(recovered.outcomes.some((outcome) => outcome.kind === 'recovery'))

    // A migrated auto save.
    const migrator = await openPage(world, world.tab('c'))
    const startup = startupHandlers(
        { core: migrator.core, test: true, emit: () => undefined },
        migrator.tab.waiter,
    )
    const migrated = await migrator.tab.run(() =>
        startup.migrateAutoSave({
            ...stateBatch(widen(a, 4)),
            hash: 'f'.repeat(64),
            ids: { chainId: testId(), docId: testId(), lineageId: testId(), sessionId: 'migrated' },
            operation: originOperation('autoSave'),
            appVersion: '0.6.0',
            wall: at(3, 12),
        }),
    )
    assert.equal(migrated.kind, 'migrated')

    const origins = new Set([...rows(world, 'sessions').values()].map((row) => String(row.origin)))
    for (const origin of ['import', 'journal', 'migrated']) assert.ok(origins.has(origin), origin)
    const reader = new Reader(world, migrator)
    await reader.expectAll('journal and migration')
    assert.equal(session.id.length > 0, true)
})

// --- The memo's bound and a session that holds only its divider.

test('the memo keeps at most 32 sessions and drops the least recently read', async () => {
    const world = createWorld({ seed: 41 })
    const page = await openPage(world, world.tab('a'))
    await page.tab.run(() =>
        page.core.write(['sessions', 'entries'], async (tx) => {
            for (let i = 0; i < 40; i++) {
                const id = `S${String(i).padStart(2, '0')}`
                await tx.put('sessions', {
                    id,
                    chainId: 'chain',
                    origin: 'nxsp',
                    lastSeq: 1,
                    entryCount: 1,
                })
                await tx.put('entries', {
                    sessionId: id,
                    seq: 1,
                    time: at(i, 12),
                    kind: 'edit',
                    step: editStep(futureFixtureOperation(id)),
                    snapshot: new Uint8Array(32),
                })
            }
        }),
    )
    const reader = new Reader(world, page)
    const read = (id: string) => reader.index({ sessionId: id, zone: 'UTC' })
    // The first session stays warm by being read between the others.
    await read('S00')
    for (let i = 1; i < 36; i++) {
        await read(`S${String(i).padStart(2, '0')}`)
        await read('S00')
        assert.equal(reader.linear, 0, 'S00 hits')
    }
    assert.equal(reader.memo.size, 32)
    // S01 was read once, long ago, and is gone; S35 is still there.
    await read('S35')
    assert.equal(reader.linear, 0)
    await read('S01')
    assert.equal(reader.linear, 1)
})

test('a session whose only row is its divider has no piece and no top', async () => {
    const world = createWorld({ seed: 42 })
    const page = await openPage(world, world.tab('a'))
    await page.tab.run(() =>
        page.core.write(['sessions', 'entries'], async (tx) => {
            for (const origin of ['continued', 'nxsp']) {
                await tx.put('sessions', {
                    id: origin,
                    chainId: 'chain',
                    origin,
                    lastSeq: 1,
                    entryCount: 1,
                })
                await tx.put('entries', {
                    sessionId: origin,
                    seq: 1,
                    time: at(0, 12),
                    kind: 'continue',
                    operation: nativeOperation(
                        { id: 'nse.continue', data: { fromTime: at(0, 11) } },
                        'Continued',
                    ),
                    snapshot: new Uint8Array(32),
                })
            }
        }),
    )
    const reader = new Reader(world, page)
    for (const id of ['continued', 'nxsp']) {
        const result = await reader.expectEquivalent({ sessionId: id, zone: 'UTC' }, id)
        assert.deepEqual(result.pieces, [])
        assert.equal(result.top, undefined)
    }
})
