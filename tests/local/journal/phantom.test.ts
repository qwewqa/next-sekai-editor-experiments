import assert from 'node:assert/strict'
import test from 'node:test'
import { captureName } from '../../../src/history/operations'
import type { FlushSession } from '../../../src/local/flush'
import { equalBytes, fromHex16, toHex } from '../../../src/local/hash'
import { MemoryStorage, storageJournalStore } from '../../../src/local/journal/store'
import { toRecords } from '../../../src/local/records/records'
import { encodeSnapshot } from '../../../src/local/records/snapshot'
import { journalledSession } from '../../../src/local/startup/resume'
import { checkStored } from '../../../src/local/testing/invariants'
import { createWorld, type World } from '../../../src/local/testing/world'
import type { State } from '../../../src/state'
import { editStep, futureFixtureOperation, nativeOperation } from '../../helpers/historySteps'
import { rows } from '../flush/harness'
import { sampleState } from '../records/samples'
import { readOpen, resumeIn } from '../startup/harness'
import { widen } from '../timeline/helpers'
import { append, beginSession, openJournalPage, replayAll } from './harness'

// The journal names only real entries (architecture review A, AP; invariant I-17). A journal's
// `seq` is the newest entry the session holds. A page resumed past a Save's marker holds none
// above the stored session's `lastSeq`, so it writes no journal until it has an entry, and the
// next load recovers nothing (F1). A journal-only reload numbers its recovered entry past the
// marker, never at the `seq` the Save's file holds (F5, I-9).

const rootOf = (state: State) => toHex(encodeSnapshot(toRecords(state)).root.hash)

const stored = (world: World, sessionId: string) =>
    [...rows(world, 'entries').values()]
        .filter((row) => row.sessionId === sessionId)
        .sort((a, b) => (a.seq as number) - (b.seq as number))
        .map((row) => [row.seq, row.kind])

/** A flusher whose marker lookup names `seq`, as `storing.ts` wires `reservedSeq: markedSeq`. */
const marked = (seq: number) => ({ reservedSeq: () => seq })

const chart = () => sampleState('tests/fixtures/generated-large.json')

test('a reload past a marker journals nothing, and the next load recovers nothing (F1)', async () => {
    const world = createWorld({ seed: 2901 })
    const storage = new MemoryStorage()
    const page = await openJournalPage(world, 'a', storage)
    const a = chart()
    const session = beginSession(page, a)
    await page.flusher.flush({ strict: true })
    const b = widen(a)
    append(page, { kind: 'edit', step: editStep(futureFixtureOperation('Changed note')) }, b)
    await page.flusher.flush({ strict: true })
    // A Save reserves 3 and writes its file; the tab reloads before the binding
    // (saveCore.spec.ts "a reload after close()").
    assert.equal(page.flusher.reserveSave()?.seq, 3)
    assert.equal(page.writer.write(), true)
    page.tab.kill()
    assert.equal(storage.length, 0, 'nothing unflushed at the kill: no journal')

    const reloaded = await openJournalPage(world, 'reload', storage, {}, {}, marked(3))
    const read = await readOpen(reloaded, session.id)
    reloaded.live.state = b
    const resumed = resumeIn(reloaded, read)
    assert.equal(resumed.pending.length, 0)
    assert.equal(resumed.nextSeq, 4, 'the marker seq is not handed out again')
    assert.equal(reloaded.flusher.newestSeq(resumed), 2, 'the newest entry is the stored one')
    assert.equal(reloaded.flusher.unflushed(resumed), false, 'nothing is unflushed')
    // pagehide
    assert.equal(reloaded.writer.write(), true)
    assert.equal(storage.length, 0, 'no journal for a seq no entry has')
    reloaded.tab.kill()

    const { outcomes } = await replayAll(world, storage)
    assert.deepEqual(outcomes, [], 'the next load applies no journal')
    assert.deepEqual(stored(world, session.id), [
        [1, 'init'],
        [2, 'edit'],
    ])
    assert.deepEqual(checkStored(world.memory), [])
})

test('a reload past a marker and an earlier kept gap journals nothing; an edit is journalled at its own seq (F1)', async () => {
    const world = createWorld({ seed: 2902 })
    const storage = new MemoryStorage()
    const page = await openJournalPage(world, 'a', storage)
    const a = chart()
    const session = beginSession(page, a)
    await page.flusher.flush({ strict: true })
    const b = widen(a)
    append(page, { kind: 'edit', step: editStep(futureFixtureOperation('Changed note')) }, b)
    await page.flusher.flush({ strict: true })
    // Save 1 reserves 3 and its write is ambiguous: the seq is kept as a gap. Save 2 reserves 4,
    // writes its file, and the tab reloads before the binding.
    const first = page.flusher.reserveSave()!
    await page.flusher.endSave(first, undefined, undefined, true)
    assert.equal(page.flusher.reserveSave()?.seq, 4)
    assert.equal(
        page.flusher.newestSeq(page.flusher.session!),
        2,
        'a gap and a reservation are no entries',
    )
    page.tab.kill()

    const reloaded = await openJournalPage(world, 'reload', storage, {}, {}, marked(4))
    const read = await readOpen(reloaded, session.id)
    reloaded.live.state = b
    const resumed = resumeIn(reloaded, read)
    assert.equal(resumed.nextSeq, 5)
    assert.equal(reloaded.flusher.newestSeq(resumed), 2, 'the hole at 3 is no entry either')
    assert.equal(reloaded.flusher.unflushed(resumed), false)
    assert.equal(reloaded.writer.write(), true)
    assert.equal(storage.length, 0, 'no journal of the hole')

    // An edit after the marker is journalled at its own seq.
    const c = widen(b)
    append(reloaded, { kind: 'edit', step: editStep(futureFixtureOperation('Later')) }, c)
    assert.equal(resumed.pending.at(-1)?.seq, 5)
    assert.equal(reloaded.flusher.newestSeq(resumed), 5)
    assert.equal(reloaded.flusher.unflushed(resumed), true)
    assert.equal(reloaded.writer.write(), true)
    assert.equal(storage.length, 1)
    reloaded.tab.kill()

    const { outcomes } = await replayAll(world, storage)
    assert.equal(outcomes[0]?.kind, 'applied')
    assert.deepEqual(stored(world, session.id), [
        [1, 'init'],
        [2, 'edit'],
        [5, 'recovered'],
    ])
    const recovered = [...rows(world, 'entries').values()].find(
        (row) => row.sessionId === session.id && row.seq === 5,
    )!
    assert.ok(equalBytes(recovered.snapshot as Uint8Array, fromHex16(rootOf(c))))
    assert.deepEqual(checkStored(world.memory), [])
})

test('an edit and an entry-carrying end raise the journal seq; a reservation or a let-go one does not', async () => {
    const world = createWorld({ seed: 2904 })
    const storage = new MemoryStorage()
    const page = await openJournalPage(world, 'a', storage)
    const a = chart()
    beginSession(page, a)
    await page.flusher.flush({ strict: true })
    const session = page.flusher.session!
    assert.equal(page.flusher.newestSeq(session), 1)
    const reservation = page.flusher.reserveSave()!
    assert.equal(reservation.seq, 2)
    assert.equal(page.flusher.newestSeq(session), 1, 'a reservation is no entry')
    const b = widen(a)
    append(page, { kind: 'edit', step: editStep(futureFixtureOperation('During the build')) }, b)
    assert.equal(page.flusher.newestSeq(session), 3, 'an edit made while the Save builds')
    await page.flusher.endSave(reservation, {
        wall: 1,
        operation: nativeOperation(
            { id: 'nse.file.save', data: { file: captureName('coconut.nxsp'), delivery: 'file' } },
            'Saved',
        ),
    })
    assert.equal(page.flusher.newestSeq(session), 3, 'the Save entry sits below the edit')
    const next = page.flusher.reserveSave()!
    assert.equal(next.seq, 4)
    await page.flusher.endSave(next)
    assert.equal(page.flusher.newestSeq(session), 3, 'a let-go reservation is no entry')
})

test('a trailing Save’s entry is the journal’s seq, and its journal is written at it', async () => {
    const world = createWorld({ seed: 2905 })
    const storage = new MemoryStorage()
    // Storage never answers: the Save's entry stays pending behind the edit.
    const page = await openJournalPage(
        world,
        'a',
        storage,
        {},
        {},
        { transport: () => new Promise(() => undefined) },
    )
    const a = chart()
    beginSession(page, a)
    const b = widen(a)
    append(page, { kind: 'edit', step: editStep(futureFixtureOperation('Changed note')) }, b)
    const session = page.flusher.session!
    const reservation = page.flusher.reserveSave()!
    assert.equal(reservation.seq, 3)
    assert.equal(page.flusher.newestSeq(session), 2, 'the reservation is no entry yet')
    void page.flusher.endSave(reservation, {
        wall: 1,
        operation: nativeOperation(
            { id: 'nse.file.save', data: { file: captureName('coconut.nxsp'), delivery: 'file' } },
            'Saved',
        ),
    })
    assert.equal(page.flusher.newestSeq(session), 3, 'the Save entry is the newest entry')
    assert.equal(page.flusher.unflushed(session), true)
    assert.equal(page.writer.write(), true)
    const [found] = await storageJournalStore(() => storage, 'nse.').read()
    assert.equal((JSON.parse(found!.text) as { seq: number }).seq, 3)
})

test('a fork’s superseded journal stays until the fork holds all it moved', async () => {
    const world = createWorld({ seed: 2906 })
    const storage = new MemoryStorage()
    const page = await openJournalPage(world, 'a', storage)
    const a = chart()
    const from = beginSession(page, a)
    append(page, { kind: 'edit', step: editStep(futureFixtureOperation('Changed note')) }, widen(a))
    assert.equal(page.writer.write(), true)
    assert.equal(storage.getItem(`nse.journal.${from.id}`) === null, false)
    // The old session's two entries moved to a fork, numbered 1 and 2 there (a fork that is not
    // the open session, so its own journal does not clear the old key at once).
    page.writer.forked(from, { id: 'F', nextSeq: 3, entrySeq: 2 } as FlushSession)
    page.writer.committed('F', 1, true)
    assert.equal(storage.getItem(`nse.journal.${from.id}`) === null, false, 'entry 1 of 2')
    page.writer.committed('F', 2, true)
    assert.equal(storage.getItem(`nse.journal.${from.id}`), null)
})

test('a journal-only reload numbers its recovered entry past the marker (F5)', async () => {
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
    const a = chart()
    beginSession(page, a)
    append(page, { kind: 'edit', step: editStep(futureFixtureOperation('Changed note')) }, widen(a))
    assert.equal(page.flusher.reserveSave()?.seq, 3)
    assert.equal(page.writer.write(), true)
    page.tab.kill()

    const next = await openJournalPage(world, 'reload', storage, {}, {}, marked(3))
    const found = (await storageJournalStore(() => storage, 'nse.').read())[0]!
    const journalled = journalledSession(found)!
    assert.equal(journalled.seq, 2, 'the journal names the newest entry, 2')
    const resumed = next.flusher.resumeJournalled({
        ...journalled,
        operation: nativeOperation(
            { id: 'nse.recovery', data: { droppedSteps: 0 } },
            'Recovered last change',
        ),
    })
    assert.deepEqual(
        resumed.pending.map((entry) => [entry.seq, entry.kind]),
        [[4, 'recovered']],
        'the Save seq 3 stays free',
    )
    assert.equal(next.flusher.newestSeq(resumed), 4)
    assert.equal(resumed.nextSeq, 5)
})
