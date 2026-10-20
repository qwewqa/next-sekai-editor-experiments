import assert from 'node:assert/strict'
import test from 'node:test'
import { captureName } from '../../../src/history/operations'
import { fromHex16, toHex } from '../../../src/local/hash'
import { toRecords } from '../../../src/local/records/records'
import { encodeSnapshot } from '../../../src/local/records/snapshot'
import { BIND_STORES, finishOwnSave, type OwnSaveBelow } from '../../../src/local/save/bind'
import type { EntryRow } from '../../../src/local/save/cut'
import { carries } from '../../../src/local/save/model'
import { checkStored } from '../../../src/local/testing/invariants'
import { createWorld } from '../../../src/local/testing/world'
import { replay } from '../../../src/local/timeline'
import { startupHandlers } from '../../../src/local/worker/startupHandlers'
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
import { goldenChart, stateOf } from '../records/charts'
import { storedEntries, widen as widenBy } from '../timeline/helpers'
import { openPage, rows, testId, type Page } from './harness'

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
            page.core.write(BIND_STORES, (tx) =>
                finishOwnSave(tx, chainId, entry, unit, 2_000_000, below),
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

test('our own completed Save kept while a batch past its `seq` is in flight is stored, never acknowledged unsent', async () => {
    const world = createWorld({ seed: 18 })
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
    assert.deepEqual(checkStored(world.memory), [])
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
    if (journal) {
        assert.equal(page.writer.write(), true)
        const { outcomes } = await replayAll(world, page.storage)
        assert.equal(outcomes[0]?.kind, 'applied')
    }
    page.tab.kill()
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
