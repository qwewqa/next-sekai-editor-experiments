import assert from 'node:assert/strict'
import test from 'node:test'
import { fromHex16, toHex } from '../../../src/local/hash'
import { toRecords } from '../../../src/local/records/records'
import { encodeSnapshot } from '../../../src/local/records/snapshot'
import { createWorld } from '../../../src/local/testing/world'
import type { State } from '../../../src/state'
import { replaceNote } from '../../../src/state/mutations/slides/note'
import { createTransaction } from '../../../src/state/transaction'
import { goldenChart, stateOf } from '../records/charts'
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
        label: () => 'Imported',
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
    page.flusher.append('edit', () => 'Changed note', edited, true)
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
            label: () => 'Saved coconut.nxsp',
            state: first,
            revisionId: 'rev-1',
            device: DEVICE,
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
            label: () => 'Saved',
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
            label: () => 'Saved coconut.nxsp',
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
