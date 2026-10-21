import assert from 'node:assert/strict'
import { describe } from 'node:test'
import { captureName } from '../../../src/history/operations'
import { fromHex16, toHex } from '../../../src/local/hash'
import { MemoryStorage, storageJournalStore } from '../../../src/local/journal/store'
import { executePlan, planNxsp } from '../../../src/local/nxsp'
import { toRecords } from '../../../src/local/records/records'
import { encodeSnapshot } from '../../../src/local/records/snapshot'
import { BIND_STORES, finishOwnSave } from '../../../src/local/save/bind'
import type { EntryRow } from '../../../src/local/save/cut'
import { carries } from '../../../src/local/save/model'
import { journalledSession } from '../../../src/local/startup/resume'
import { stateBatch } from '../../../src/local/stateBatch'
import { checkStored } from '../../../src/local/testing/invariants'
import type { World } from '../../../src/local/testing/world'
import type { WorkerContext } from '../../../src/local/worker/handlers'
import { openHandlers } from '../../../src/local/worker/openHandlers'
import type { State } from '../../../src/state'
import {
    editStep,
    futureFixtureOperation,
    nativeOperation,
    originOperation,
} from '../../helpers/historySteps'
import { append, beginSession, openJournalPage, replayAll } from '../journal/harness'
import { fresh } from '../nxsp/chain'
import { crafted, jsonOf, setJson } from '../nxsp/craft'
import { chartWith, levelOf } from '../nxsp/helpers'
import { goldenChart, stateOf } from '../records/charts'
import { sampleState } from '../records/samples'
import { continueIn, readOpen, resumeIn } from '../startup/harness'
import { widen } from '../timeline/helpers'
import { openPage, rows, testId } from './harness'
import { importIds, longFile, storeRequest as storeRequestFor } from './modelFiles'
import {
    createCheckedWorld as createWorld,
    expectViolations,
    pin,
    checkedTest as test,
} from './sessionCheck'

// Scenario tests on the real flusher, journal, worker core and resume (design A §7), promoted from
// the validation probes. The first half pass on today's code: what the A0+ checker allows and
// reports, the hole learning, and the two power losses. The second half are `todo` acceptance
// tests, each naming the increment that turns it green; they fail on today's tree and `npm test`
// stays green. When that increment merges, it removes the `todo`.

const rootOf = (state: State) => toHex(encodeSnapshot(toRecords(state)).root.hash)
const DEVICE = { id: 'device-1', label: 'Web (Chrome)' }
const SAVE_OPERATION = nativeOperation(
    { id: 'nse.file.save', data: { file: captureName('coconut.nxsp'), delivery: 'file' } },
    'Saved coconut.nxsp',
)
const CHANGED = () => editStep(futureFixtureOperation('Changed note'))
const LARGE = 'tests/fixtures/generated-large.json'

const kinds = (world: World, sessionId: string) =>
    [...rows(world, 'entries').values()]
        .filter((row) => row.sessionId === sessionId)
        .sort((a, b) => (a.seq as number) - (b.seq as number))
        .map((row) => [row.seq, row.kind])

/** The marker a resume reads, as `storing.ts` wires `reservedSeq`. */
const markedAt = (page: { flusher: unknown }, seq: number) => {
    ;(page.flusher as { deps: { reservedSeq?: (id: string) => number } }).deps.reservedSeq = () =>
        seq
}

/** The unit and `save` entry of our own completed Save, as `ownSave` in `saveEntry.test.ts`. */
const ownSaveUnit = (sessionId: string, seq: number, state: State, count: number, time = 5) => ({
    entry: {
        sessionId,
        seq,
        time,
        operation: SAVE_OPERATION,
        snapshot: rootOf(state),
        noteCount: 1,
        revisionId: 'rev-1',
        device: DEVICE,
    },
    unit: {
        docId: testId(),
        revision: { id: 'rev-1', n: 1, ancestors: [] },
        file: {
            name: 'coconut.nxsp',
            event: 'saved',
            at: time,
            hash: fromHex16(rootOf(state)),
            options: { history: true, bgm: true },
            entry: { sessionId, seq, startedAt: 0, count, notKept: 0 },
        },
        marks: [],
    },
})

/** Whether the chain's cut carries over what storage holds now (today's `carries`). */
const carriesNow = (world: World, sessionId: string, chainId: string) => {
    const chain = rows(world, 'chains').get(chainId)!
    const cut = (chain.file as { entry: Parameters<typeof carries>[1] }).entry
    const { startedAt } = rows(world, 'sessions').get(sessionId) as { startedAt: number }
    const chainRows = [...rows(world, 'entries').values()]
        .filter((row) => row.sessionId === sessionId)
        .map((row) => ({ entry: row as unknown as EntryRow, startedAt }))
    return carries(chainRows, { ...cut, startedAt }, (row) => !row.entry.kept)
}

const bind = (
    page: { core: { write: (stores: typeof BIND_STORES, fn: never) => Promise<unknown> } },
    chainId: string,
    save: ReturnType<typeof ownSaveUnit>,
    below: 'stored' | 'pending',
) =>
    (
        page.core as unknown as {
            write: <T>(
                stores: typeof BIND_STORES,
                fn: (tx: never) => Promise<T>,
                options: { durability: 'strict' },
            ) => Promise<T>
        }
    ).write(
        BIND_STORES,
        (tx) => finishOwnSave(tx, chainId, save.entry, save.unit, 2_000_000, below),
        // As the worker's handler writes it (`bindHandlers.ts`): a recognised Save is strict.
        { durability: 'strict' },
    )

// ---------------------------------------------------------------------------------------------
// The checker as A0+ corrects it: allowed states pass, breaches are named.

const ids = importIds(0)
const storeRequest = (id: string) => storeRequestFor(id, ids)

test('an ended import leaves holes I-3 allows: the checker reports none (F3)', async () => {
    const world = createWorld({ seed: 911 })
    const page = await openPage(world, world.tab('a'))
    const context: WorkerContext = { core: page.core, test: true, emit: () => undefined }
    const open = openHandlers(context, page.tab.waiter)
    const file = await longFile(2100)
    const reply = await page.tab.run(() => open.openRead(file))
    assert.equal(reply.kind, 'nxsp')
    if (reply.kind !== 'nxsp') return
    const stored = await page.tab.run(() => open.openStore(storeRequest(reply.id)))
    assert.equal(stored.kind, 'stored')
    assert.equal(await page.tab.run(() => open.openAbandon(ids.sessionId)), true)
    // The session holds fewer rows than its lastSeq names: the rows the import never brought.
    const session = rows(world, 'sessions').get(ids.sessionId)!
    const held = [...rows(world, 'entries').values()].filter(
        (row) => row.sessionId === ids.sessionId,
    )
    assert.ok(held.length < (session.lastSeq as number), 'the import ended short')
    assert.equal(session.importPending, undefined)
    assert.deepEqual(checkStored(world.memory), [])
})

test('a Duplicate Tab fork of a session its own tab goes on writing is not a parent breach (F3)', async () => {
    const world = createWorld({ seed: 912 })
    const a = await openPage(world, world.tab('a'))
    const state = stateOf(goldenChart())
    const session = a.flusher.begin({
        id: 'S',
        docId: 'doc-S',
        origin: 'import',
        state,
        operation: originOperation('import'),
        dirty: false,
    })
    await a.flusher.flush({ strict: true })
    const b1 = widen(state)
    a.flusher.append({ kind: 'edit', step: editStep(futureFixtureOperation('Changed')) }, b1, true)
    await a.flusher.flush({ strict: true })
    // Duplicate Tab: the copy finds S's lock held and forks it (a new chain, parent {S, 2}).
    const dup = await openPage(world, world.tab('dup'))
    const read = await readOpen(dup, session.id)
    const fork = continueIn(dup, read, { asFork: true })
    dup.flusher.append(
        { kind: 'edit', step: editStep(futureFixtureOperation('Copy edit')) },
        widen(b1),
        true,
    )
    await dup.flusher.flush({ strict: true })
    // The original tab goes on editing S, its chain's head, as it may.
    a.flusher.append(
        { kind: 'edit', step: editStep(futureFixtureOperation('More')) },
        widen(b1),
        true,
    )
    await a.flusher.flush({ strict: true })
    const sessions = rows(world, 'sessions')
    assert.notEqual(sessions.get(fork.id)?.chainId, sessions.get('S')?.chainId, 'another chain')
    assert.equal(sessions.get('S')?.lastSeq, 3)
    assert.deepEqual(checkStored(world.memory), [])
    await world.idle()
})

test('an open with an outside change writes two own rows with one time (I-6)', async () => {
    const world = createWorld({ seed: 913 })
    const page = await openPage(world, world.tab('a'))
    const context: WorkerContext = { core: page.core, test: true, emit: () => undefined }
    const open = openHandlers(context, page.tab.waiter)
    const chain = fresh()
    const file = await executePlan(planNxsp(chain.input).plan, new Map())
    // The level differs from the history's head: the open adds "Changed outside the editor".
    const edited = stateOf(chartWith({ extraNotes: 3 }))
    const changed = await crafted((items) => {
        setJson(items, 'level.json', levelOf(edited).level)
        setJson(items, 'project.json', jsonOf(items, 'project.json'))
    }, file)
    const reply = await page.tab.run(() => open.openRead(changed))
    if (reply.kind !== 'nxsp') throw new Error(reply.kind)
    const stored = await page.tab.run(() =>
        open.openStore({ ...storeRequest(reply.id), level: stateBatch(edited) }),
    )
    assert.equal(stored.kind, 'stored')
    const own = [...rows(world, 'entries').values()]
        .filter((row) => row.sessionId === ids.sessionId && (row.seq as number) > 4)
        .sort((x, y) => (x.seq as number) - (y.seq as number))
    assert.equal(own.length, 2)
    assert.equal(own[0]!.time, own[1]!.time, 'the edit and the continue share one time')
    assert.deepEqual(checkStored(world.memory), [])
})

// ---------------------------------------------------------------------------------------------
// Holes the flusher made (R2-2, R2-4, R3-7): learned from every reservation, every end and the
// marker a resume reads, except a `seq` whose end added the entry.

test('a reservation never ended is a learned hole: the resumed session may store past it (R2-2)', async () => {
    const world = createWorld({ seed: 3301 })
    const storage = new MemoryStorage()
    const page = await openJournalPage(world, 'a', storage)
    const a = sampleState(LARGE)
    const session = beginSession(page, a)
    await page.flusher.flush({ strict: true })
    const b = widen(a)
    append(page, { kind: 'edit', step: CHANGED() }, b)
    await page.flusher.flush({ strict: true })
    // The Save reserves 3 and writes its file; the tab reloads before the binding: never ended.
    assert.equal(page.flusher.reserveSave()?.seq, 3)
    page.tab.kill()

    const reloaded = await openJournalPage(world, 'reload', storage)
    markedAt(reloaded, 3)
    const read = await readOpen(reloaded, session.id)
    reloaded.live.state = b
    resumeIn(reloaded, read)
    // The user edits instead of saving again: seq 4, past the hole at 3.
    append(reloaded, { kind: 'edit', step: editStep(futureFixtureOperation('Later')) }, widen(b))
    await reloaded.flusher.flush({ strict: true })
    assert.deepEqual(kinds(world, session.id), [
        [1, 'init'],
        [2, 'edit'],
        [4, 'edit'],
    ])
    assert.equal(world.holes.has(session.id, 3), true)
    // The checked test passes only because the hole is learned: without the ledger it is a breach.
    assert.match(checkStored(world.memory).join('\n'), /rows 3 up to lastSeq 4 are neither stored/)
    assert.deepEqual(checkStored(world.memory, world.sessionOptions), [])
})

test('a hole is learned from the marker a resume reads, though the page never saw its Save', async () => {
    const world = createWorld({ seed: 3303 })
    const page = await openJournalPage(world, 'a')
    const a = sampleState(LARGE)
    const session = beginSession(page, a)
    await page.flusher.flush({ strict: true })
    page.tab.kill()
    const next = await openJournalPage(world, 'next')
    markedAt(next, 2)
    const read = await readOpen(next, session.id)
    next.live.state = a
    resumeIn(next, read)
    assert.equal(world.holes.has(session.id, 2), true)
    append(next, { kind: 'edit', step: CHANGED() }, widen(a))
    await next.flusher.flush({ strict: true })
    assert.deepEqual(kinds(world, session.id), [
        [1, 'init'],
        [3, 'edit'],
    ])
    assert.deepEqual(checkStored(world.memory, world.sessionOptions), [])
})

test('a `save` row a defect lost is still reported: a seq whose end added the entry is never excused (R3-7)', async () => {
    expectViolations(
        /rows 2 up to lastSeq 3 are neither stored/,
        /was removed while the session stays/,
    )
    const world = createWorld({ seed: 3302 })
    const page = await openJournalPage(world, 'a', new MemoryStorage())
    const a = sampleState(LARGE)
    const session = beginSession(page, a)
    await page.flusher.flush({ strict: true })
    const reservation = page.flusher.reserveSave()!
    assert.equal(reservation.seq, 2)
    await page.flusher.endSave(reservation, {
        wall: 5_000_000,
        operation: SAVE_OPERATION,
        state: a,
        revisionId: 'rev-1',
        device: DEVICE,
        appVersion: '0.6.0',
    })
    append(page, { kind: 'edit', step: editStep(futureFixtureOperation('After')) }, widen(a))
    await page.flusher.flush({ strict: true })
    assert.deepEqual(checkStored(world.memory, world.sessionOptions), [])
    // A defect that never stored the `save` row at 2, with row 3 above it and the counts agreeing.
    await page.tab.run(() =>
        page.core.write(['entries', 'sessions'], async (tx) => {
            await tx.delete('entries', [session.id, 2])
            const row = (await tx.get('sessions', session.id)) as Record<string, number>
            await tx.put('sessions', { ...row, entryCount: row.entryCount! - 1 })
        }),
    )
    assert.equal(world.holes.has(session.id, 2), false)
    const found = checkStored(world.memory, world.sessionOptions)
    assert.equal(found.length, 1)
    assert.match(found[0]!, /rows 2 up to lastSeq 3 are neither stored/)
})

test('a journal-only reload’s recovered entry is no hole: if it is lost, the checker says so (M1)', async () => {
    expectViolations(
        /rows 1, 2, 4 up to lastSeq 4 are neither stored/,
        /was removed while the session stays/,
        // The stored stack no longer follows from the rows.
        /replay gives/,
        /past replay.s stack/,
    )
    const world = createWorld({ seed: 2903 })
    const storage = new MemoryStorage()
    // Storage never answers: the edits live in the journal alone.
    const page = await openJournalPage(
        world,
        'a',
        storage,
        {},
        {},
        { transport: () => new Promise(() => undefined) },
    )
    const a = sampleState(LARGE)
    beginSession(page, a)
    append(page, { kind: 'edit', step: CHANGED() }, widen(a))
    assert.equal(page.flusher.reserveSave()?.seq, 3)
    assert.equal(page.writer.write(), true)
    page.tab.kill()

    const next = await openJournalPage(world, 'reload', storage)
    markedAt(next, 3)
    const found = (await storageJournalStore(() => storage, 'nse.').read())[0]!
    const resumed = next.flusher.resumeJournalled({
        ...journalledSession(found)!,
        operation: nativeOperation(
            { id: 'nse.recovery', data: { droppedSteps: 0 } },
            'Recovered last change',
        ),
    })
    // The recovered entry takes 4; the Save's 3 is the hole.
    assert.deepEqual(
        resumed.pending.map((entry) => entry.seq),
        [4],
    )
    assert.equal(world.holes.has(resumed.id, 3), true)
    assert.equal(world.holes.has(resumed.id, 4), false)
    await next.flusher.flush({ strict: true })
    assert.deepEqual(checkStored(world.memory, world.sessionOptions), [])
    // A defect that never stores the journal's only copy of the edits, with the counts agreeing.
    await next.tab.run(() =>
        next.core.write(['entries', 'sessions'], async (tx) => {
            await tx.delete('entries', [resumed.id, 4])
            const row = (await tx.get('sessions', resumed.id)) as Record<string, number>
            await tx.put('sessions', { ...row, entryCount: row.entryCount! - 1 })
        }),
    )
})

// ---------------------------------------------------------------------------------------------
// The two power losses (R2-5, R3-6). `loseCommits(n)` models Firefox before 126, which ignores
// durability, so it runs with the journal writer as the page runs it there, `strictCommits:
// false`: no commit clears a journal. With the default writer a strict commit clears the journal
// and the loss then undoes that commit, a state no browser in the gate reaches.

const lostEdit = async (seed: number, strictCommits: boolean | undefined) => {
    const world = createWorld({ seed, commitLog: true })
    const storage = new MemoryStorage()
    const page = await openJournalPage(
        world,
        'a',
        storage,
        strictCommits === undefined ? {} : { strictCommits },
    )
    const a = sampleState(LARGE)
    const session = beginSession(page, a)
    await page.flusher.flush({ strict: true })
    append(page, { kind: 'edit', step: CHANGED() }, widen(a))
    page.live.state = widen(a)
    assert.equal(page.writer.write(), true, 'hide: the journal names entry 2')
    // Strict: Chromium keeps it; Firefox before 126 may not have it on disk.
    await page.flusher.flush({ strict: true })
    page.tab.kill()
    assert.equal(world.memory.loseCommits(1), 1)
    assert.equal(rows(world, 'sessions').get(session.id)?.lastSeq, 1)
    await replayAll(world, storage, 'reload')
    return [...rows(world, 'entries').values()].find(
        (row) => row.sessionId === session.id && row.seq === 2,
    )
}

test('loseCommits with strictCommits: false (Firefox before 126 as it runs): the journal recovers the edit', async () => {
    const row = await lostEdit(3402, false)
    assert.equal(row?.kind, 'recovered')
})

test('loseCommits with the default journal writer loses the edit: a state no browser in the gate is known to reach (WebKit: D14), so not modelled', async () => {
    assert.equal(await lostEdit(3401, undefined), undefined)
})

test('loseRelaxed with the default writer: the journal a relaxed flush left keeps the edit as a recovery session (Chromium, Firefox 126 and later)', async () => {
    const world = createWorld({ seed: 3403, commitLog: true })
    const storage = new MemoryStorage()
    const page = await openJournalPage(world, 'a', storage)
    const a = sampleState(LARGE)
    const session = beginSession(page, a)
    await page.flusher.flush({ strict: true })
    append(page, { kind: 'edit', step: CHANGED() }, widen(a))
    page.live.state = widen(a)
    await page.flusher.flush()
    assert.equal(world.memory.relaxedCommits, 1)
    assert.equal(page.writer.write(), true, 'hide: a relaxed entry is journalled')
    page.tab.kill()
    world.memory.loseRelaxed(1)
    assert.equal(rows(world, 'sessions').get(session.id)?.lastSeq, 1)
    // The stored stack went back with the loss, so the journal's kept slots are outside it: the
    // edit is kept as a recovery session of its own, never lost.
    const { outcomes } = await replayAll(world, storage, 'reload')
    assert.equal(outcomes[0]?.kind, 'recovery')
    assert.equal(storage.length, 0)
    assert.deepEqual(kinds(world, session.id), [[1, 'init']])
})

// ---------------------------------------------------------------------------------------------
// F2's setup: a relaxed commit a power loss undid, with or without the journal recovering it. Row 3
// is acknowledged relaxed when the Save reserves 4.

type Loss = 'relaxed' | 'commits'

const reloadAfter = async (seed: number, loss: Loss, journal: boolean) => {
    const world = createWorld({ seed, commitLog: true })
    const storage = new MemoryStorage()
    const page = await openJournalPage(
        world,
        'a',
        storage,
        loss === 'commits' ? { strictCommits: false } : {},
    )
    const a = sampleState(LARGE)
    const b = widen(a)
    const session = beginSession(page, a)
    await page.flusher.flush({ strict: true })
    append(page, { kind: 'edit', step: CHANGED() }, b)
    await page.flusher.flush({ strict: true })
    // Undo, flushed relaxed (the one-second flush): acknowledged by a database, not strict.
    append(page, { kind: 'undo', step: CHANGED() }, a)
    await page.flusher.flush()
    const live = page.flusher.session!
    assert.deepEqual([live.ackedSeq, live.strictSeq], [3, 2], 'row 3 acknowledged relaxed')
    const reservation = page.flusher.reserveSave()!
    assert.equal(reservation.seq, 4)
    assert.equal(page.flusher.unstored(live).entries.length, 0, 'the build takes no pending row')
    page.live.state = a
    assert.equal(page.writer.write(), true)
    if (!journal) for (let k = storage.length - 1; k >= 0; k--) storage.removeItem(storage.key(k)!)
    page.tab.kill()
    if (loss === 'relaxed') world.memory.loseRelaxed(world.memory.relaxedCommits)
    if (loss === 'commits') world.memory.loseCommits(1)
    await replayAll(world, storage, 'reload')
    const reloaded = await openJournalPage(world, 'reload2', new MemoryStorage())
    markedAt(reloaded, 4)
    const read = await readOpen(reloaded, session.id)
    reloaded.live.state = a
    const resumed = resumeIn(reloaded, read)
    const lastSeq = read.session.lastSeq as number
    const last = [...rows(world, 'entries').values()].find(
        (row) => row.sessionId === session.id && row.seq === lastSeq,
    )
    return { world, session, a, page, reloaded, resumed, lastSeq, last }
}

/** A page whose flusher never reaches the worker while `stalled.on` is set. */
const stallable = (page: { flusher: unknown }) => {
    const stalled = { on: false }
    const own = page.flusher as { deps: { transport: unknown } }
    const transport = own.deps.transport as (...args: unknown[]) => Promise<unknown>
    own.deps.transport = async (...args: unknown[]) => {
        if (stalled.on) await new Promise(() => undefined)
        return transport(...args)
    }
    return stalled
}

/** F2: recognised over a row a power loss undid and a journal recovered. */
const f2 = async (seed: number) => {
    const { world, session, a, reloaded } = await reloadAfter(seed, 'relaxed', true)
    await bind(reloaded, session.chainId, ownSaveUnit(session.id, 4, a, 4), 'stored')
    return { world, session }
}

/** AR-8: a journal folds the pending `save` entry into `recovered@r`; recognised after the reload. */
const ar8 = async (seed: number) => {
    const world = createWorld({ seed })
    const page = await openJournalPage(world, 'a')
    const stalled = stallable(page)
    const a = stateOf(goldenChart())
    const session = beginSession(page, a)
    await page.flusher.flush({ strict: true })
    const b = widen(a)
    append(page, { kind: 'edit', step: CHANGED() }, b)
    await page.flusher.flush({ strict: true })
    // Stored through 2. The Save reserves 3, writes its file, and the entry and unit are pending;
    // the flush that would store them never reaches the worker (a reload).
    stalled.on = true
    const reservation = page.flusher.reserveSave()!
    assert.equal(reservation.seq, 3)
    const save = ownSaveUnit(session.id, 3, b, 3)
    void page.flusher.endSave(
        reservation,
        {
            wall: reservation.wall,
            operation: SAVE_OPERATION,
            state: b,
            revisionId: 'rev-1',
            device: DEVICE,
        },
        save.unit,
    )
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
    // pagehide: the journal holds seq 3 (the pending save entry is the newest).
    assert.equal(page.writer.write(), true)
    page.tab.kill()
    const { outcomes } = await replayAll(world, page.storage)
    assert.equal(outcomes[0]?.kind, 'applied')
    assert.deepEqual(kinds(world, session.id), [
        [1, 'init'],
        [2, 'edit'],
        [3, 'recovered'],
    ])
    // The reloaded tab recognises its own completed Save: nothing pending below 3.
    const reloaded = await openPage(world, world.tab('reload'))
    await bind(reloaded, session.chainId, save, 'stored')
    return { world, session }
}

/** AR-8b: a journal folds a pending row the file holds into `recovered@2`; then the Save is recognised. */
const ar8b = async (seed: number) => {
    const world = createWorld({ seed })
    const page = await openJournalPage(world, 'a')
    const stalled = stallable(page)
    const a = sampleState(LARGE)
    const session = beginSession(page, a)
    await page.flusher.flush({ strict: true })
    // Storage stalls: edit 2 pending; the Save reserves 3 and its build takes row 2.
    stalled.on = true
    const b = widen(a)
    append(page, { kind: 'edit', step: CHANGED() }, b)
    void page.flusher.flush()
    const reservation = page.flusher.reserveSave()!
    assert.equal(reservation.seq, 3)
    // The file lands (init, edit@2, save@3); the page reloads before the binding.
    assert.equal(page.writer.write(), true)
    page.tab.kill()
    const { outcomes } = await replayAll(world, page.storage)
    assert.equal(outcomes[0]?.kind, 'applied')
    assert.deepEqual(kinds(world, session.id), [
        [1, 'init'],
        [2, 'recovered'],
    ])
    const reloaded = await openPage(world, world.tab('reload'))
    await bind(reloaded, session.chainId, ownSaveUnit(session.id, 3, b, 3), 'stored')
    return { world, session }
}

const hasSaveRow = (world: World, sessionId: string, seq: number) =>
    kinds(world, sessionId).some(([at, kind]) => at === seq && kind === 'save')

// Today's code over-claims in each (design A §1.1). These pass now and pin the breach; A2 deletes
// them as it removes the `todo` from the acceptance tests below.

test('F2 today: the cut carries over recovered@3 where the file holds an undo (pinned, A2)', async () => {
    const { world, session } = await f2(921)
    assert.equal(hasSaveRow(world, session.id, 4), true)
    assert.equal(carriesNow(world, session.id, session.chainId), true)
})

test('AR-8 today: the cut carries over recovered@3 where the file holds save@3 (pinned, A2)', async () => {
    const { world, session } = await ar8(801)
    assert.equal(carriesNow(world, session.id, session.chainId), true)
})

test('AR-8b today: landsOn accepts recovered@2, so save@3 is written and the cut carries (pinned, A2)', async () => {
    expectViolations(
        pin(
            /lock: rows 3 of session \S+ were created while the page did not hold/,
            'A2',
            'I-1: finishOwnSave writes save@r from a page that does not hold the session',
        ),
    )
    const { world, session } = await ar8b(802)
    assert.equal(hasSaveRow(world, session.id, 3), true)
    assert.equal(carriesNow(world, session.id, session.chainId), true)
})

test('a kept Save added to a session the page has left writes nothing (the late writer, M1c)', async () => {
    const world = createWorld({ seed: 4601 })
    const page = await openJournalPage(world, 'a')
    const a = stateOf(goldenChart())
    const session = beginSession(page, a)
    await page.flusher.flush({ strict: true })
    // The Save's file may hold seq 2 (a kept gap), and the build found an entry pending below it.
    const reservation = page.flusher.reserveSave()!
    await page.flusher.endSave(reservation, undefined, undefined, true)
    const below = { kind: 'pending', session, seq: reservation.seq, after: { state: a } }
    // The page moves on to another session before the Save is added.
    beginSession(page, stateOf(goldenChart()))
    await page.flusher.flush({ strict: true })
    await page.flusher.keptSave(below as never, {
        wall: 5,
        operation: SAVE_OPERATION,
        revisionId: 'rev-1',
        device: DEVICE,
    })
    await page.flusher.flush({ strict: true })
    assert.equal(hasSaveRow(world, session.id, reservation.seq), false)
    assert.equal(session.pending.length, 0)
    assert.deepEqual(page.errors, [])
})

const A2 = { todo: 'A2: one writer of a session’s rows' }

describe('A2 acceptance (expected to fail before they land)', () => {
    test(
        'F2: a Save recognised over a row a power loss undid and a journal recovered does not carry',
        async () => {
            const { world, session } = await f2(921)
            // Either no row is added at 4, or the cut does not carry over recovered@3.
            assert.ok(
                !hasSaveRow(world, session.id, 4) ||
                    !carriesNow(world, session.id, session.chainId),
            )
        },
        A2,
    )

    test(
        'AR-8: a journal folds the pending save entry into recovered@r, and the cut does not carry over it',
        async () => {
            const { world, session } = await ar8(801)
            assert.equal(carriesNow(world, session.id, session.chainId), false)
        },
        A2,
    )

    test(
        'AR-8b: a recovered row that replaced a pending row the file holds is not the Save’s landing',
        async () => {
            const { world, session } = await ar8b(802)
            // Landing on recovered@2 is not the Save's: no row at 3, or a cut that does not carry.
            assert.ok(
                !hasSaveRow(world, session.id, 3) ||
                    !carriesNow(world, session.id, session.chainId),
            )
        },
        A2,
    )
})
