import assert from 'node:assert/strict'
import { describe } from 'node:test'
import { captureName } from '../../../src/history/operations'
import { fromHex16, toHex } from '../../../src/local/hash'
import { toRecords } from '../../../src/local/records/records'
import { encodeSnapshot } from '../../../src/local/records/snapshot'
import { BIND_STORES, finishOwnSave, type OwnSaveBelow } from '../../../src/local/save/bind'
import type { EntryRow } from '../../../src/local/save/cut'
import { carries } from '../../../src/local/save/model'
import { checkStored, checkStrict } from '../../../src/local/testing/invariants'
import { replay } from '../../../src/local/timeline'
import { startupHandlers } from '../../../src/local/worker/startupHandlers'
import { readTimelineIndex } from '../../../src/local/worker/timelineHandlers'
import type { State } from '../../../src/state'
import { replaceNote } from '../../../src/state/mutations/slides/note'
import { createTransaction } from '../../../src/state/transaction'
import {
    editStep,
    futureFixtureOperation,
    nativeOperation,
    originOperation,
} from '../../helpers/historySteps'
import { append, beginSession, openJournalPage, replayAll } from '../journal/harness'
import { edgeChart, goldenChart, stateOf } from '../records/charts'
import { continueIn, readOpen } from '../startup/harness'
import { storedEntries, widen as widenBy } from '../timeline/helpers'
import { openPage, rows, testId, type Page } from './harness'
import {
    createCheckedWorld as createWorld,
    expectViolations,
    pin,
    checkedTest as test,
} from './sessionCheck'

// A Save's `save` entry (Part 1 §1.6.11.6): its `seq` reserved before the build, edits made
// meanwhile after it and held until the entry is appended, its `revisionId` and `device` stored,
// and the identity unit committed with it in one transaction (§1.3.2).

const widen = (state: State) => {
    const notes = [...state.store.slides.note.values()].flat()
    const target = notes[0]!
    const transaction = createTransaction(state)
    replaceNote(transaction, target, { ...target, size: target.size + 0.25 })
    return transaction.commit([])
}

const begin = (page: Page, state: State) =>
    page.flusher.begin({
        id: testId(),
        docId: testId(),
        origin: 'import',
        state,
        operation: originOperation('import'),
        dirty: false,
    })

const rootOf = (state: State) => toHex(encodeSnapshot(toRecords(state)).root.hash)

// Violations the checker finds in a state a test builds, as evidence for architecture review A:
// AR-2 (a late row stamped later than the rows above it), AR-3 (the net removes the stored stack),
// the same rows seen by the transition check (created at or below `lastSeq`, I-2), and the first
// test's hand-made writer, which ignores the order on purpose. Each is a pin: A2 clears it.
const LATE_TIME = pin(
    /row 4 \(time \d+\) is later than row 5 \(time \d+\)/,
    'A2',
    'AR-2: keptSave stores a row below lastSeq under a later stamp',
)
const WRITER_TIME = pin(
    /row 3 \(time \d+\) is later than row 4 \(time 5\)/,
    'A2',
    'AR-2: a writer that ignores the order, then the net',
)
const NET_STACK = pin(
    /its stored stack is missing/,
    'A2',
    'AR-3: the net (behind) removes the stored stack',
)
const BELOW_LAST_SEQ = pin(
    /rows [\d, ]+ of session \S+ were created at or below its lastSeq/,
    'A2',
    'I-2: keptSave and the net store rows under lastSeq',
)
const LAST_SEQ_HIGH = pin(
    /has lastSeq \d+ after creating rows up to \d+/,
    'A2',
    'I-2: the same rows leave lastSeq above the highest created',
)

const DEVICE = { id: 'device-1', label: 'Web (Chrome)' }

test('a save entry takes its reserved seq; edits during the build wait and follow it', async () => {
    const world = createWorld({ seed: 11 })
    const page = await openPage(world, world.tab('a'))
    const first = stateOf(goldenChart())
    const session = begin(page, first)
    await page.flusher.flush()

    const reservation = page.flusher.reserveSave()!
    assert.equal(reservation.seq, 2)
    // A second Save can't reserve meanwhile.
    assert.equal(page.flusher.reserveSave(), undefined)
    // The reserved seq isn't an entry: the journal's seq stays at the newest one.
    assert.equal(page.flusher.newestSeq(session), 1)

    const edited = widen(first)
    page.flusher.append(
        {
            kind: 'edit',
            step: editStep(
                nativeOperation(
                    { id: 'nse.object.edit', data: { subject: 'note', changed: { note: 1 } } },
                    'Changed note',
                ),
            ),
        },
        edited,
        true,
    )
    await page.flusher.flush()
    // Held behind the reservation.
    assert.equal(rows(world, 'entries').size, 1)
    assert.equal(page.flusher.newestSeq(session), 3)

    const docId = testId()
    const revision = { id: 'rev-1', n: 1, ancestors: [] }
    await page.flusher.endSave(
        reservation,
        {
            wall: reservation.wall,
            operation: nativeOperation(
                {
                    id: 'nse.file.save',
                    data: { file: captureName('coconut.nxsp'), delivery: 'file' },
                },
                'Saved coconut.nxsp',
            ),
            state: first,
            revisionId: 'rev-1',
            device: DEVICE,
            appVersion: '0.6.0',
        },
        {
            docId,
            revision,
            file: {
                name: 'coconut.nxsp',
                event: 'saved',
                at: reservation.wall,
                hash: fromHex16(rootOf(first)),
                entry: { sessionId: session.id, seq: 2, startedAt: 0, count: 2, notKept: 0 },
                options: { history: true, bgm: true },
            },
            marks: [],
        },
    )
    assert.deepEqual(page.errors, [])
    const entries = [...rows(world, 'entries').values()]
    assert.deepEqual(
        entries.map((row) => [row.seq, row.kind]),
        [
            [1, 'init'],
            [2, 'save'],
            [3, 'edit'],
        ],
    )
    const save = entries[1]!
    assert.equal(save.revisionId, 'rev-1')
    assert.deepEqual(save.device, DEVICE)
    // The app version that wrote the Save stays on its row; no other row has one.
    assert.equal(save.appVersion, '0.6.0')
    assert.deepEqual(
        entries.filter((row) => 'appVersion' in row).map((row) => row.kind),
        ['save'],
    )
    assert.equal(toHex(save.snapshot as Uint8Array), rootOf(first))

    const [chain] = rows(world, 'chains').values()
    const [sessionRow] = rows(world, 'sessions').values()
    assert.equal(chain!.docId, docId)
    assert.deepEqual(chain!.revision, revision)
    const file = chain!.file as Record<string, unknown>
    assert.equal(file.name, 'coconut.nxsp')
    // The cut's session start as stored, whatever the page sent.
    assert.equal((file.entry as Record<string, unknown>).startedAt, sessionRow!.startedAt)
    assert.equal(session.identity, undefined)
    assert.equal(session.docId, docId)
})

test('a Save that wrote nothing lets a trailing seq go, and keeps it when its file may hold it', async () => {
    const world = createWorld({ seed: 12 })
    const page = await openPage(world, world.tab('a'))
    const session = begin(page, stateOf(goldenChart()))
    await page.flusher.flush()

    const failed = page.flusher.reserveSave()!
    await page.flusher.endSave(failed)
    assert.equal(session.nextSeq, 2)
    assert.equal(session.reserved, undefined)

    const unknown = page.flusher.reserveSave()!
    await page.flusher.endSave(unknown, undefined, undefined, true)
    // The gap stays: our own completed Save may record its entry there.
    assert.equal(session.nextSeq, 3)
    assert.equal(page.flusher.newestSeq(session), 1)
    // A gap with no entry is never a pending change.
    assert.equal(page.flusher.unflushed(session), false)
})

test('a mark the identity unit needs that isn’t stored keeps the binding in memory', async () => {
    const world = createWorld({ seed: 13 })
    const page = await openPage(world, world.tab('a'))
    const first = stateOf(goldenChart())
    const session = begin(page, first)
    await page.flusher.flush()
    const reservation = page.flusher.reserveSave()!
    await page.flusher.endSave(
        reservation,
        {
            wall: reservation.wall,
            operation: nativeOperation(
                {
                    id: 'nse.file.save',
                    data: { file: captureName('coconut.nxsp'), delivery: 'file' },
                },
                'Saved',
            ),
            state: first,
            revisionId: 'rev-1',
            device: DEVICE,
        },
        {
            docId: session.docId,
            revision: { id: 'rev-1', n: 1, ancestors: [] },
            file: {
                name: 'coconut.nxsp',
                event: 'saved',
                at: reservation.wall,
                hash: fromHex16(rootOf(first)),
                options: { history: true, bgm: true },
            },
            // A row of this session that was never stored.
            marks: [{ sessionId: session.id, seq: 9 }],
        },
    )
    const [chain] = rows(world, 'chains').values()
    assert.equal(chain!.file, undefined)
    assert.ok(session.identity)
    // The save entry is stored all the same.
    assert.equal(rows(world, 'entries').size, 2)
})

test('an identity unit whose binding was taken over meanwhile is dropped, never stored', async () => {
    const world = createWorld({ seed: 14 })
    const page = await openPage(world, world.tab('a'))
    const first = stateOf(goldenChart())
    const session = begin(page, first)
    await page.flusher.flush()
    const reservation = page.flusher.reserveSave()!
    // Another tab's save picker takes the file over while this Save writes (R5).
    const [chain] = rows(world, 'chains').values()
    const replaced = { by: 'other-chain', at: 5, name: 'coconut.nxsp' }
    await page.core.write(['chains'], (tx) =>
        tx.put('chains', { ...chain, replaced, edited: true, hasContent: true }),
    )
    await page.flusher.endSave(
        reservation,
        {
            wall: reservation.wall,
            operation: nativeOperation(
                {
                    id: 'nse.file.save',
                    data: { file: captureName('coconut.nxsp'), delivery: 'file' },
                },
                'Saved coconut.nxsp',
            ),
            state: first,
            revisionId: 'rev-1',
            device: DEVICE,
        },
        {
            docId: testId(),
            revision: { id: 'rev-1', n: 1, ancestors: [] },
            file: {
                name: 'coconut.nxsp',
                event: 'saved',
                at: reservation.wall,
                hash: fromHex16(rootOf(first)),
                options: { history: true, bgm: true },
            },
            marks: [],
            // The record had no binding and no revocation when the Save began.
            from: {},
        },
    )
    assert.deepEqual(page.errors, [])
    const [after] = rows(world, 'chains').values()
    assert.equal(after!.file, undefined)
    assert.deepEqual(after!.replaced, replaced)
    // Dropped from memory too, while the `save` entry is stored.
    assert.equal(session.identity, undefined)
    assert.ok([...rows(world, 'entries').values()].some((row) => row.kind === 'save'))
})

test('Export fields set while the first write is in flight survive its acknowledgement', async () => {
    const world = createWorld({ seed: 117 })
    let reached!: () => void
    let release!: () => void
    const atTransport = new Promise<void>((resolve) => {
        reached = resolve
    })
    const hold = new Promise<void>((resolve) => {
        release = resolve
    })
    let first = true
    const page = await openPage(world, world.tab('a'), {
        transport: async (batch) => {
            const result = await page.tab.run(() => page.handlers.flush(batch))
            if (first) {
                first = false
                reached()
                await hold
            }
            return result
        },
        writeChain: (request) =>
            page.tab.run(() =>
                startupHandlers({
                    core: page.core,
                    test: true,
                    emit: () => undefined,
                }).writeChainFields(request),
            ),
    })
    begin(page, stateOf(goldenChart()))
    const writing = page.flusher.flush()
    await atTransport
    const metadata = page.flusher.setChainFields({
        exportName: 'Coconut',
        exportTarget: {
            name: 'LevelData',
            handle: { testHandle: 'LevelData' },
            disk: { fingerprint: 'abc', size: 12, lastModified: 0 },
        },
    })
    release()
    await writing
    assert.equal(await metadata, true)
    const [chain] = rows(world, 'chains').values()
    assert.equal(chain!.exportName, 'Coconut')
    assert.equal((chain!.exportTarget as Record<string, unknown>).name, 'LevelData')
    assert.equal(rows(world, 'handles').size, 1)
})

const exportFields = {
    exportName: 'New export',
    exportTarget: {
        name: 'NewLevelData',
        handle: { testHandle: 'NewLevelData' },
        disk: { fingerprint: 'abc', size: 12, lastModified: 0 },
    },
}

const metadataPage = async (seed: number) => {
    const world = createWorld({ seed })
    let fail = false
    const page = await openPage(world, world.tab('a'), {
        transport: (batch) => {
            if (fail) return Promise.reject(new Error('Storage paused'))
            return page.tab.run(() => page.handlers.flush(batch))
        },
        writeChain: (request) =>
            page.tab.run(() =>
                startupHandlers({
                    core: page.core,
                    test: true,
                    emit: () => undefined,
                }).writeChainFields(request),
            ),
    })
    return {
        world,
        page,
        fail: (value: boolean) => {
            fail = value
        },
    }
}

test('failed first Export registration is never deferred into an ordinary retry flush', async () => {
    const { world, page, fail } = await metadataPage(118)
    const session = begin(page, stateOf(goldenChart()))
    fail(true)
    assert.equal(await page.flusher.setChainFieldsNow(exportFields), false)
    assert.equal(session.chainSet?.exportTarget, undefined)
    fail(false)
    await page.flusher.flush()
    const [chain] = rows(world, 'chains').values()
    assert.equal(chain!.exportTarget, undefined)
    assert.equal(rows(world, 'handles').size, 0)
    assert.equal(await page.flusher.setChainFieldsNow(exportFields), true)
    assert.equal(rows(world, 'handles').size, 1)
})

test('new Export metadata commits after a pending Save As identity and survives later flushes', async () => {
    const { world, page, fail } = await metadataPage(119)
    const state = stateOf(goldenChart())
    const session = begin(page, state)
    await page.flusher.flush()
    await page.flusher.setChainFieldsNow({ ...exportFields, exportName: 'Old export' })
    const reservation = page.flusher.reserveSave()!
    fail(true)
    await page.flusher.endSave(
        reservation,
        {
            wall: reservation.wall,
            operation: nativeOperation(
                { id: 'nse.file.save', data: { file: captureName('copy.nxsp'), delivery: 'file' } },
                'Saved copy',
            ),
            state,
            revisionId: 'new-revision',
            device: DEVICE,
        },
        {
            clearExport: true,
            docId: 'new-document',
            revision: { id: 'new-revision', n: 1, ancestors: [] },
            file: { name: 'copy.nxsp', at: reservation.wall },
            marks: [],
        },
    )
    assert.equal(session.identity?.clearExport, true)
    fail(false)
    assert.equal(await page.flusher.setChainFieldsNow(exportFields), true)
    assert.equal(session.identity, undefined)
    page.flusher.append(
        {
            kind: 'edit',
            step: editStep(
                nativeOperation(
                    { id: 'nse.object.edit', data: { subject: 'note', changed: { note: 1 } } },
                    'Later edit',
                ),
            ),
        },
        widen(state),
        true,
    )
    await page.flusher.flush()
    const [chain] = rows(world, 'chains').values()
    assert.equal(chain!.docId, 'new-document')
    assert.equal(chain!.exportName, 'New export')
    assert.equal((chain!.exportTarget as Record<string, unknown>).name, 'NewLevelData')
    assert.equal(rows(world, 'handles').size, 1)
})

// Our own completed Save (§1.4.7) recorded while entries before its kept `seq` are still pending:
// a session's entries are stored in `seq` order, so its `lastSeq` never passes one not stored.

const editNote = (page: Page, state: State) => {
    const next = widen(state)
    page.flusher.append(
        {
            kind: 'edit',
            step: editStep(
                nativeOperation(
                    { id: 'nse.object.edit', data: { subject: 'note', changed: { note: 1 } } },
                    'Changed note',
                ),
            ),
        },
        next,
        true,
    )
    return next
}

const SAVE_OPERATION = nativeOperation(
    { id: 'nse.file.save', data: { file: captureName('coconut.nxsp'), delivery: 'file' } },
    'Saved coconut.nxsp',
)

const ownSave = (
    page: Page,
    sessionId: string,
    chainId: string,
    seq: number,
    state: State,
    /** The file's rows, its `save` entry's among them: the binding's cut. */
    count?: number,
    wall = 2_000_000,
) => {
    const entry = {
        sessionId,
        seq,
        time: 5,
        operation: SAVE_OPERATION,
        snapshot: rootOf(state),
        noteCount: 1,
        revisionId: 'rev-1',
        device: DEVICE,
    }
    const unit = {
        docId: testId(),
        revision: { id: 'rev-1', n: 1, ancestors: [] },
        file: {
            name: 'coconut.nxsp',
            event: 'saved',
            at: 5,
            hash: fromHex16(rootOf(state)),
            options: { history: true, bgm: true },
            ...(count === undefined
                ? {}
                : { entry: { sessionId, seq, startedAt: 0, count, notKept: 0 } }),
        },
        marks: [],
    }
    return {
        entry,
        record: (below?: OwnSaveBelow) =>
            // Strict, as the worker's `finishOwnSave` handler writes it (`bindHandlers.ts`).
            page.core.write(
                BIND_STORES,
                (tx) => finishOwnSave(tx, chainId, entry, unit, wall, below),
                { durability: 'strict' },
            ),
    }
}

type TestWorld = ReturnType<typeof createWorld>

const kinds = (world: TestWorld) =>
    [...rows(world, 'entries').values()].map((row) => [row.seq, row.kind])

const sessionRow = (world: TestWorld) => {
    const [row] = rows(world, 'sessions').values()
    return row!
}

test('our own completed Save with entries before it still pending is stored after them', async () => {
    const world = createWorld({ seed: 15 })
    let stall = false
    let release!: () => void
    const stalled = new Promise<void>((resolve) => (release = resolve))
    const page: Page = await openPage(world, world.tab('a'), {
        transport: async (batch) => {
            if (stall) await stalled
            page.batches.push(batch)
            const result = await page.tab.run(() => page.handlers.flush(batch))
            page.results.push(result)
            return result
        },
    })
    const first = stateOf(goldenChart())
    const session = begin(page, first)
    await page.flusher.flush()
    // The flush of the next edits stalls (storage slow or paused).
    stall = true
    const second = editNote(page, first)
    const third = editNote(page, second)
    const reservation = page.flusher.reserveSave()!
    assert.equal(reservation.seq, 4)
    // Its file may hold the entry: the `seq` is kept, and the flush of 2 and 3 waits.
    const ended = page.flusher.endSave(reservation, undefined, undefined, true)

    const below = page.flusher.keptSaveBelow(session.id, 4)
    if (below?.kind !== 'pending') throw new Error('Expected entries pending below the Save')
    const save = ownSave(page, session.id, session.chainId, 4, third)
    assert.equal(await save.record(below.kind), true)
    // The binding is recorded; the entry waits for the tab, after 2 and 3.
    assert.deepEqual(kinds(world), [[1, 'init']])
    assert.equal(sessionRow(world).lastSeq, 1)
    const [chain] = rows(world, 'chains').values()
    assert.equal((chain!.revision as { id: string }).id, 'rev-1')

    const kept = page.flusher.keptSave(below, {
        wall: save.entry.time,
        operation: save.entry.operation,
        revisionId: save.entry.revisionId,
        device: save.entry.device,
    })
    release()
    await ended
    await kept
    assert.deepEqual(page.errors, [])
    assert.deepEqual(kinds(world), [
        [1, 'init'],
        [2, 'edit'],
        [3, 'edit'],
        [4, 'save'],
    ])
    const stored = [...rows(world, 'entries').values()][3]!
    assert.equal(toHex(stored.snapshot as Uint8Array), rootOf(third))
    assert.equal(stored.revisionId, 'rev-1')
    assert.equal(sessionRow(world).lastSeq, 4)
    assert.equal(sessionRow(world).entryCount, 4)
    assert.equal(session.pending.length, 0)
    assert.equal(session.gaps?.has(4) ?? false, false)
    assert.equal(page.flusher.newestSeq(session), 4)
})

test('our own completed Save of a session another tab may hold never passes its stored entries', async () => {
    const world = createWorld({ seed: 16 })
    const page = await openPage(world, world.tab('a'))
    const first = stateOf(goldenChart())
    const session = begin(page, first)
    await page.flusher.flush()
    const second = editNote(page, first)
    const third = editNote(page, second)
    const reservation = page.flusher.reserveSave()!
    const save = ownSave(page, session.id, session.chainId, reservation.seq, third)
    // Not this tab's to order: written only right after its stored entries.
    assert.equal(await save.record(), true)
    assert.deepEqual(kinds(world), [[1, 'init']])
    assert.equal(sessionRow(world).lastSeq, 1)
    await page.flusher.endSave(reservation, undefined, undefined, true)
    assert.deepEqual(page.errors, [])
    assert.deepEqual(kinds(world), [
        [1, 'init'],
        [2, 'edit'],
        [3, 'edit'],
    ])
    assert.equal(session.pending.length, 0)
    // Once it follows the stored entries, it is written.
    assert.equal(await save.record(), true)
    assert.deepEqual(kinds(world).at(-1), [4, 'save'])
    assert.equal(sessionRow(world).lastSeq, 4)
})

test('a flush stores pending entries a write put `lastSeq` past, never skipping them', async () => {
    expectViolations(WRITER_TIME, NET_STACK, BELOW_LAST_SEQ, LAST_SEQ_HIGH)
    const world = createWorld({ seed: 17 })
    const page = await openPage(world, world.tab('a'))
    const first = stateOf(goldenChart())
    const session = begin(page, first)
    await page.flusher.flush()
    const second = editNote(page, first)
    const third = editNote(page, second)
    const reservation = page.flusher.reserveSave()!
    // A writer that ignores the order: the `save` entry lands first and `lastSeq` passes 2 and 3.
    await page.core.write(['sessions', 'entries'], async (tx) => {
        const init = (await tx.get('entries', [session.id, 1])) as Record<string, unknown>
        await tx.put('entries', {
            sessionId: session.id,
            seq: reservation.seq,
            time: 5,
            day: init.day,
            kind: 'save',
            operation: SAVE_OPERATION,
            snapshot: fromHex16(rootOf(third)),
            noteCount: 1,
            dirty: false,
            kept: true,
            revisionId: 'rev-1',
            device: DEVICE,
        })
        const row = (await tx.get('sessions', session.id)) as Record<string, unknown>
        await tx.put('sessions', {
            ...row,
            lastSeq: reservation.seq,
            entryCount: (row.entryCount as number) + 1,
        })
    })
    assert.equal(sessionRow(world).lastSeq, 4)
    await page.flusher.endSave(reservation, undefined, undefined, true)
    assert.deepEqual(page.errors, [])
    assert.deepEqual(kinds(world), [
        [1, 'init'],
        [2, 'edit'],
        [3, 'edit'],
        [4, 'save'],
    ])
    const stored = sessionRow(world)
    assert.equal(stored.lastSeq, 4)
    assert.equal(stored.entryCount, 4)
    // The stored stack was after entry 1: behind the entries now, so it went (replay rebuilds it).
    assert.equal(stored.stack, undefined)
    assert.equal(rows(world, 'stackBlocks').size, 0)
    assert.equal(session.pending.length, 0)
})

/** A kept Save stored below lastSeq while a batch past its seq is in flight (AR-2, AR-3). */
const keptWhileInFlight = async (seed: number) => {
    const world = createWorld({ seed })
    let stall = false
    let release!: () => void
    const stalled = new Promise<void>((resolve) => (release = resolve))
    const page: Page = await openPage(world, world.tab('a'), {
        transport: async (batch) => {
            if (stall) await stalled
            page.batches.push(batch)
            const result = await page.tab.run(() => page.handlers.flush(batch))
            page.results.push(result)
            return result
        },
    })
    const first = stateOf(goldenChart())
    const session = begin(page, first)
    await page.flusher.flush()
    stall = true
    const second = editNote(page, first)
    const third = editNote(page, second)
    const reservation = page.flusher.reserveSave()!
    assert.equal(reservation.seq, 4)
    // Its file may hold the entry: 4 is a kept gap, and a batch can take entries on both sides.
    const ended = page.flusher.endSave(reservation, undefined, undefined, true)
    editNote(page, third)
    // The batch [2, 3, 5] is extracted and in flight.
    for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve))

    const below = page.flusher.keptSaveBelow(session.id, 4)
    if (below?.kind !== 'pending') throw new Error('Expected entries pending below the Save')
    const save = ownSave(page, session.id, session.chainId, 4, third)
    assert.equal(await save.record(below.kind), true)
    const kept = page.flusher.keptSave(below, {
        wall: save.entry.time,
        operation: save.entry.operation,
        revisionId: save.entry.revisionId,
        device: save.entry.device,
    })
    release()
    await ended
    await kept
    await page.flusher.flush({ strict: true })
    return { world, page, session }
}

test('our own completed Save kept while a batch past its `seq` is in flight is stored, never acknowledged unsent', async () => {
    expectViolations(LATE_TIME, NET_STACK, BELOW_LAST_SEQ, LAST_SEQ_HIGH)
    const { world, page, session } = await keptWhileInFlight(18)
    assert.deepEqual(page.errors, [])
    assert.deepEqual(
        page.batches.map((batch) => batch.entries.map((entry) => entry.seq)),
        [[1], [2, 3, 5], [4]],
    )
    assert.deepEqual(kinds(world), [
        [1, 'init'],
        [2, 'edit'],
        [3, 'edit'],
        [4, 'save'],
        [5, 'edit'],
    ])
    assert.equal(sessionRow(world).entryCount, 5)
    assert.equal(session.pending.length, 0)
    // AR-2: the kept Save is stored below a row already stored above it (`checkedTest` expects it).
})

test('our own completed Save stored below `lastSeq` alone leaves the head’s summary (LS3-1)', async () => {
    expectViolations(LATE_TIME, NET_STACK, BELOW_LAST_SEQ, LAST_SEQ_HIGH)
    const world = createWorld({ seed: 20 })
    let stall = false
    let release!: () => void
    const stalled = new Promise<void>((resolve) => (release = resolve))
    const page: Page = await openPage(world, world.tab('a'), {
        transport: async (batch) => {
            if (stall) await stalled
            page.batches.push(batch)
            const result = await page.tab.run(() => page.handlers.flush(batch))
            page.results.push(result)
            return result
        },
    })
    const first = stateOf(goldenChart())
    const session = begin(page, first)
    await page.flusher.flush()
    stall = true
    const second = editNote(page, first)
    const third = editNote(page, second)
    const reservation = page.flusher.reserveSave()!
    assert.equal(reservation.seq, 4)
    const ended = page.flusher.endSave(reservation, undefined, undefined, true)
    // The head after the Save is another chart, with another title.
    const head = stateOf(edgeChart())
    assert.notEqual(head.levelInfo.title, third.levelInfo.title)
    page.flusher.append(
        {
            kind: 'edit',
            step: editStep(
                nativeOperation(
                    { id: 'nse.object.edit', data: { subject: 'note', changed: { note: 1 } } },
                    'Changed note',
                ),
            ),
        },
        head,
        true,
    )
    for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve))
    const below = page.flusher.keptSaveBelow(session.id, 4)
    if (below?.kind !== 'pending') throw new Error('Expected entries pending below the Save')
    const save = ownSave(page, session.id, session.chainId, 4, third)
    assert.equal(await save.record(below.kind), true)
    const kept = page.flusher.keptSave(below, {
        wall: save.entry.time,
        operation: save.entry.operation,
        revisionId: save.entry.revisionId,
        device: save.entry.device,
    })
    release()
    await ended
    await kept
    await page.flusher.flush({ strict: true })
    assert.deepEqual(page.errors, [])
    assert.deepEqual(
        page.batches.map((batch) => batch.entries.map((entry) => entry.seq)),
        [[1], [2, 3, 5], [4]],
    )
    assert.deepEqual(kinds(world).at(-2), [4, 'save'])
    const chain = rows(world, 'chains').get(session.chainId)!
    assert.equal((chain.summary as { title?: string }).title, head.levelInfo.title)
})

test('our own completed Save dropped by a fork leaves a cut that under-claims (LS3-2)', async () => {
    const world = createWorld({ seed: 21 })
    let stall = false
    let release!: () => void
    const stalled = new Promise<void>((resolve) => (release = resolve))
    let continued = false
    const page: Page = await openPage(world, world.tab('a'), {
        transport: async (batch) => {
            if (stall) await stalled
            // Another tab continues the chain before the kept Save's own batch.
            if (!continued && batch.entries[0]?.seq === 4) {
                continued = true
                await page.core.write(['sessions', 'chains'], async (tx) => {
                    const chain = (await tx.get('chains', batch.session.chainId)) as Record<
                        string,
                        unknown
                    >
                    await tx.put('sessions', { id: 'continuation', chainId: chain.chainId })
                    await tx.put('chains', { ...chain, head: 'continuation' })
                })
            }
            page.batches.push(batch)
            const result = await page.tab.run(() => page.handlers.flush(batch))
            page.results.push(result)
            return result
        },
    })
    const first = stateOf(goldenChart())
    const session = begin(page, first)
    await page.flusher.flush()
    stall = true
    const second = editNote(page, first)
    const third = editNote(page, second)
    const reservation = page.flusher.reserveSave()!
    const ended = page.flusher.endSave(reservation, undefined, undefined, true)
    editNote(page, third)
    for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve))
    const below = page.flusher.keptSaveBelow(session.id, 4)
    if (below?.kind !== 'pending') throw new Error('Expected entries pending below the Save')
    // The file's rows: 1, 2, 3 and its `save`.
    const save = ownSave(page, session.id, session.chainId, 4, third, 4)
    assert.equal(await save.record(below.kind), true)
    const kept = page.flusher.keptSave(below, {
        wall: save.entry.time,
        operation: save.entry.operation,
        revisionId: save.entry.revisionId,
        device: save.entry.device,
    })
    release()
    await ended
    await kept
    await page.flusher.flush({ strict: true })
    assert.deepEqual(page.errors, [])
    assert.ok(page.results.some((result) => result.kind === 'notHead'))
    // The fork takes no entry at or below the stored `lastSeq`, so the `save` row is never stored.
    assert.notEqual(page.flusher.session?.id, session.id)
    assert.deepEqual(
        kinds(world).filter(([seq]) => seq === 4),
        [],
    )
    // The chain's cut still counts it: the next write that isn't an append doesn't carry the file.
    const chain = rows(world, 'chains').get(session.chainId)!
    const cut = (chain.file as { entry: Parameters<typeof carries>[1] }).entry
    assert.equal(cut.count, 4)
    const { startedAt } = rows(world, 'sessions').get(session.id) as { startedAt: number }
    const chainRows = [...rows(world, 'entries').values()]
        .filter((row) => row.sessionId === session.id)
        .map((row) => ({ entry: row as unknown as EntryRow, startedAt }))
    assert.equal(
        carries(chainRows, { ...cut, startedAt }, () => false),
        false,
    )
})

/**
 * A Save that reserved 3 over edit 2 still pending, edit 4 made during its build; the file is
 * written and the tab dies before the binding commits. With `journal`, the reload applies the
 * journal as a `recovered` entry at 4; without, entry 2 is lost.
 */
const diedMidSave = async (seed: number, journal: boolean) => {
    const world = createWorld({ seed })
    const page = await openJournalPage(world, 'a')
    const a = stateOf(goldenChart())
    const session = beginSession(page, a)
    await page.flusher.flush()
    const b = widenBy(a)
    append(page, { kind: 'edit', step: editStep(futureFixtureOperation('Changed note')) }, b)
    const reservation = page.flusher.reserveSave()!
    assert.equal(reservation.seq, 3)
    append(
        page,
        { kind: 'edit', step: editStep(futureFixtureOperation('Moved notes')) },
        widenBy(b, 1),
    )
    if (journal) assert.equal(page.writer.write(), true)
    page.tab.kill()
    if (journal) {
        const { outcomes } = await replayAll(world, page.storage)
        assert.equal(outcomes[0]?.kind, 'applied')
    }
    return { world, session, b, reloaded: await openPage(world, world.tab('reload')) }
}

test('our own completed Save is stored only where replay lands it: never under a recovered entry, nor past lost ones', async () => {
    const cases: { journal: boolean; below?: OwnSaveBelow; rows: [number, string][] }[] = [
        // The reloaded tab resumes the session with nothing pending; another tab recognises it.
        {
            journal: true,
            below: 'stored',
            rows: [
                [1, 'init'],
                [4, 'recovered'],
            ],
        },
        {
            journal: true,
            rows: [
                [1, 'init'],
                [4, 'recovered'],
            ],
        },
        { journal: false, below: 'stored', rows: [[1, 'init']] },
    ]
    for (const [i, { journal, below, rows: expected }] of cases.entries()) {
        const { world, session, b, reloaded } = await diedMidSave(30 + i, journal)
        const save = ownSave(reloaded, session.id, session.chainId, 3, b, 3)
        assert.equal(await save.record(below), true)
        assert.deepEqual(kinds(world), expected)
        const entries = storedEntries(world, session.id)
        assert.doesNotThrow(() => replay(entries))
        assert.deepEqual(checkStored(world.memory), [])
        // The binding is recorded all the same, its cut as the file holds it (it only under-claims).
        const chain = rows(world, 'chains').get(session.chainId)!
        assert.equal((chain.revision as { id: string }).id, 'rev-1')
        assert.equal((chain.file as { entry: { count: number } }).entry.count, 3)
    }
})

test('our own completed Save over another kept gap keeps its cut as the file holds it, so the next write never over-claims', async () => {
    const world = createWorld({ seed: 19 })
    const page = await openPage(world, world.tab('a'))
    const first = stateOf(goldenChart())
    const session = begin(page, first)
    const second = editNote(page, first)
    await page.flusher.flush()
    // Saves A (3) and B (4) both end with a kept gap: their files may hold them.
    for (const seq of [3, 4]) {
        const reservation = page.flusher.reserveSave()!
        assert.equal(reservation.seq, seq)
        await page.flusher.endSave(reservation, undefined, undefined, true)
    }
    const chainRows = () => {
        const { startedAt } = sessionRow(world) as { startedAt: number }
        return [...rows(world, 'entries').values()].map((row) => ({
            entry: row as unknown as EntryRow,
            startedAt,
        }))
    }
    const cut = () => {
        const chain = rows(world, 'chains').get(session.chainId)!
        return (chain.file as { entry: Parameters<typeof carries>[1] }).entry
    }
    // A later visit recognises B (the file's rows 1, 2 and B's `save`): the gap 3 below it may be
    // entries a tab still holds, so no row. The cut still counts B's row, which the chain lacks, so
    // the next write that isn't an append doesn't carry B (ADV3-1): it says "Some earlier steps
    // were not kept." once.
    assert.equal(await ownSave(page, session.id, session.chainId, 4, second, 3).record(), true)
    assert.deepEqual(kinds(world), [
        [1, 'init'],
        [2, 'edit'],
    ])
    assert.equal(cut().count, 3)
    assert.equal(
        carries(chainRows(), cut(), () => false),
        false,
    )
    // Nor when a row the file never held is stored below the cut later and the counts agree again:
    // the chain still lacks the cut's own row.
    const late = chainRows()[1]!
    const grown = [...chainRows(), { ...late, entry: { ...late.entry, seq: 3 } }]
    assert.equal(grown.filter((row) => row.entry.seq <= 4).length, cut().count)
    assert.equal(
        carries(grown, cut(), () => false),
        false,
    )
    // Recognising A, right after the stored entries, writes its row and keeps its cut whole.
    assert.equal(await ownSave(page, session.id, session.chainId, 3, second, 3).record(), true)
    assert.deepEqual(kinds(world).at(-1), [3, 'save'])
    assert.equal(cut().count, 3)
    assert.equal(
        carries(chainRows(), cut(), () => false),
        true,
    )
})

// Architecture review A, acceptance tests for A2 (one writer of a session's rows). Each states what
// holds once only the session's own flusher stores its rows, in `seq` order, and reports as `todo`
// until A2 lands: they fail on today's tree, and `npm test` stays green. When A2 merges, remove
// the `todo`. `checkedTest` also runs the stored-data checker at the end of each, so a late row is
// reported by the invariant it breaks as well as by the assertions.

/**
 * Rows 1 and 2 stored, a Save reserving 3 whose file may hold it, 4 and 5 stored before local
 * midnight and 6 after it, then the Save recognised after midnight with everything above it stored.
 */
const recognisedLate = async (seed: number) => {
    const world = createWorld({ seed })
    const midnight = new Date(2025, 0, 15, 24).getTime()
    const minutes = (n: number) => 60_000 * n
    let clock = midnight - minutes(30)
    const page = await openPage(world, world.tab('a'), { now: () => (clock += 1) })
    const first = stateOf(goldenChart())
    const session = begin(page, first)
    const second = editNote(page, first)
    await page.flusher.flush()
    const reservation = page.flusher.reserveSave()!
    assert.equal(reservation.seq, 3)
    await page.flusher.endSave(reservation, undefined, undefined, true)
    clock = midnight - minutes(2)
    const fourth = editNote(page, second)
    const fifth = editNote(page, fourth)
    await page.flusher.flush()
    clock = midnight + minutes(5)
    editNote(page, fifth)
    await page.flusher.flush({ strict: true })
    clock = midnight + minutes(10)
    const below = page.flusher.keptSaveBelow(session.id, 3)
    const save = ownSave(page, session.id, session.chainId, 3, second, 3, clock)
    assert.equal(await save.record(below?.kind), true)
    await page.flusher.flush({ strict: true })
    assert.deepEqual(page.errors, [])
    return { world, page, session }
}

const A2 = { todo: 'A2: one writer of a session’s rows' }

/**
 * AR-1's sequence: S stored through 2, a Save reserving 3 whose tab dies before the binding, a
 * later visit continuing S as C (parent S at 2) and storing rows, then that visit recognising the
 * Save as its own.
 */
const recognisedInLaterVisit = async (seed: number) => {
    const world = createWorld({ seed })
    const first = await openPage(world, world.tab('first'))
    const a = stateOf(goldenChart())
    const session = begin(first, a)
    const b = editNote(first, a)
    await first.flusher.flush()
    assert.equal(first.flusher.reserveSave()!.seq, 3)
    first.tab.kill()
    // Visit 2 continues S as C, and C stores its first rows.
    const next = await openPage(world, world.tab('next'))
    const opened = await readOpen(next, session.id)
    const child = continueIn(next, opened)
    editNote(next, b)
    await next.flusher.flush({ strict: true })
    assert.equal(rows(world, 'sessions').get(child.id)?.parent !== undefined, true)
    // The next Save recognises the file as our own: its `save` at S's 3, with the cut as the file
    // holds it (init, edit, save).
    const save = ownSave(next, session.id, session.chainId, 3, b, 3)
    assert.equal(await save.record(), true)
    return { world, session }
}

test('AR-1 today: a Save recognised in a later visit writes the parent past the branch point, outside its lock', async () => {
    expectViolations(
        pin(
            /lock: rows 3 of session \S+ were created while the page did not hold nse-session:/,
            'A2',
            'AR-1, I-1: finishOwnSave writes the parent from a page that holds only the continuation',
        ),
        pin(
            /no longer its chain's head, yet rows 3 were created in it/,
            'A2',
            'AR-1, I-5: the parent is written after the head moved to the continuation',
        ),
        pin(
            /session \S+, no longer its chain's head, changed lastSeq, updatedAt, entryCount/,
            'A2',
            'AR-1, I-5: the parent’s summary changes after the head moved',
        ),
        pin(
            /parent \S+ holds rows 3 past its uptoSeq 2/,
            'A2',
            'AR-1, I-5: the continuation’s branch point has a row above it',
        ),
        pin(
            /parent \S+ has lastSeq 3, not its uptoSeq 2/,
            'A2',
            'AR-1, I-5: the parent’s lastSeq moved past the branch point',
        ),
    )
    const { world, session } = await recognisedInLaterVisit(41)
    assert.equal(rows(world, 'sessions').get(session.id)?.lastSeq, 3)
})

describe('A2 acceptance (expected to fail before A2)', () => {
    test(
        'AR-1: a Save recognised in a later visit writes nothing into the parent past the continuation’s branch point',
        async () => {
            const { world, session } = await recognisedInLaterVisit(41)
            // The binding is recorded, but S, which C branched from at 2, is not written past it.
            assert.deepEqual(checkStored(world.memory), [])
            assert.deepEqual(world.violations, [])
            const chain = rows(world, 'chains').get(session.chainId)!
            assert.equal((chain.revision as { id: string }).id, 'rev-1')
            assert.deepEqual(
                [...rows(world, 'entries').values()]
                    .filter((row) => row.sessionId === session.id)
                    .map((row) => [row.seq, row.kind]),
                [
                    [1, 'init'],
                    [2, 'edit'],
                ],
            )
            assert.equal(rows(world, 'sessions').get(session.id)?.lastSeq, 2)
        },
        A2,
    )

    test(
        'AR-3: a Save recognised below lastSeq leaves every session with rows its stored stack',
        async () => {
            const { world } = await keptWhileInFlight(45)
            assert.deepEqual(checkStrict(world.memory, world.sessionOptions), [])
        },
        A2,
    )

    test(
        'AR-2: a Save recognised late never lands under a later time than the rows above it',
        async () => {
            const { world } = await recognisedLate(42)
            const times = [...rows(world, 'entries').values()].map((row) => row.time as number)
            for (let i = 1; i < times.length; i++)
                assert.ok(times[i - 1]! <= times[i]!, `row ${i} is later than row ${i + 1}`)
        },
        A2,
    )

    test(
        'AR-2: a Save recognised after midnight lands under no other day’s Go To piece',
        async () => {
            const { world, page, session } = await recognisedLate(43)
            // Every row of a Go To piece is on the piece's day, and the pieces hold every row.
            const { pieces } = await page.tab.run(() =>
                page.core.read(['sessions', 'entries'], (tx) =>
                    readTimelineIndex(tx, { sessionId: session.id }),
                ),
            )
            const day = (time: number) => new Date(time).setHours(0, 0, 0, 0)
            const stored = [...rows(world, 'entries').values()]
            for (const piece of pieces)
                for (const row of stored.filter(
                    (each) =>
                        (each.seq as number) >= piece.oldestSeq &&
                        (each.seq as number) <= piece.newestSeq,
                ))
                    assert.equal(
                        day(row.time as number),
                        day(piece.newest),
                        `row ${String(row.seq)} lies under another day’s piece`,
                    )
            assert.equal(
                pieces.reduce((sum, piece) => sum + piece.count, 0),
                stored.length,
            )
        },
        A2,
    )
})

test('AR-2 today: a Save recognised late is stored under a later time than the rows above it', async () => {
    expectViolations(
        pin(
            /row 3 \(time \d+\) is later than row 4 \(time \d+\)/,
            'A2',
            'AR-2: the late Save is stamped after the rows above it',
        ),
        BELOW_LAST_SEQ,
        LAST_SEQ_HIGH,
    )
    const { world } = await recognisedLate(44)
    const times = [...rows(world, 'entries').values()].map((row) => row.time as number)
    assert.ok(times[2]! > times[3]!, 'row 3 is stamped later than row 4')
})
