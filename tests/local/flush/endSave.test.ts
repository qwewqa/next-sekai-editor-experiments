import assert from 'node:assert/strict'
import { captureName } from '../../../src/history/operations'
import { nativeOperation, originOperation } from '../../helpers/historySteps'
import '../../helpers/lockChecks'
import { goldenChart, stateOf } from '../records/charts'
import { storedEntries } from '../timeline/helpers'
import { openPage, testId, type Page } from './harness'
import { createCheckedWorld as createWorld, checkedTest as test } from './sessionCheck'

// A Save's reservation is identified by its object, and `Flusher.endSave` reports what it did
// (spec A, I-12): each `EndSaveResult`, a second end that does nothing, and an end on a session
// that is no longer current.

const begin = (page: Page, state = stateOf(goldenChart())) =>
    page.flusher.begin({
        id: testId(),
        docId: testId(),
        origin: 'import',
        state,
        operation: originOperation('import'),
        dirty: false,
    })

const saveEntry = (wall: number, state = stateOf(goldenChart())) => ({
    wall,
    state,
    operation: nativeOperation(
        { id: 'nse.file.save', data: { file: captureName('coconut.nxsp'), delivery: 'file' } },
        'Saved coconut.nxsp',
    ),
})

const start = async (seed: number) => {
    const world = createWorld({ seed })
    const page = await openPage(world, world.tab('a'))
    const session = begin(page)
    await page.flusher.flush()
    return { world, page, session }
}

test('an end with an entry adds it and says so', async () => {
    const { page, session } = await start(31)
    const reservation = page.flusher.reserveSave()!
    assert.equal(session.reserved, reservation)
    const result = await page.flusher.endSave(reservation, saveEntry(reservation.wall))
    assert.equal(result, 'added')
    assert.equal(session.reserved, undefined)
    assert.equal(session.nextSeq, 3)
    assert.deepEqual(page.errors, [])
})

test('an end without an entry says kept with keep and keeps the seq, else letGo and hands a trailing one out again', async () => {
    const { page, session } = await start(32)
    const trailing = page.flusher.reserveSave()!
    assert.equal(await page.flusher.endSave(trailing), 'letGo')
    assert.equal(session.nextSeq, 2, 'a trailing seq is handed out again')
    assert.equal(session.reserved, undefined)

    const kept = page.flusher.reserveSave()!
    assert.equal(kept.seq, 2)
    assert.equal(await page.flusher.endSave(kept, undefined, undefined, true), 'kept')
    assert.equal(session.nextSeq, 3, 'a kept seq is never handed out again')
    assert.equal(page.flusher.reserveSave()?.seq, 3)
})

test('a seq an edit has followed is not handed out again when the Save lets it go', async () => {
    const { page, session } = await start(33)
    const reservation = page.flusher.reserveSave()!
    page.flusher.append(
        {
            kind: 'edit',
            step: {
                kind: 'edit',
                operation: nativeOperation(
                    { id: 'nse.object.edit', data: { subject: 'note', changed: { note: 1 } } },
                    'Changed note',
                ),
            },
        },
        stateOf(goldenChart()),
        true,
    )
    assert.equal(session.nextSeq, 4)
    assert.equal(await page.flusher.endSave(reservation), 'letGo')
    assert.equal(session.nextSeq, 4)
    assert.deepEqual(page.errors, [])
})

test('a session that is no longer current gets no entry and keeps the seq (notCurrent)', async () => {
    const { world, page, session } = await start(34)
    const reservation = page.flusher.reserveSave()!
    const other = begin(page)
    assert.notEqual(page.flusher.session, session)
    const before = session.pending.length
    const result = await page.flusher.endSave(reservation, saveEntry(reservation.wall))
    assert.equal(result, 'notCurrent')
    assert.equal(session.pending.length, before, 'nothing is added to the session it left')
    await page.flusher.flush({ strict: true })
    // The session it left gains no row, then or later: only its first entry is stored.
    assert.deepEqual(
        storedEntries(world, session.id).map(({ kind, seq }) => [kind, seq]),
        [['init', 1]],
    )
    assert.equal(session.nextSeq, 3, 'the seq stays used: the file may hold it')
    assert.equal(session.reserved, undefined)
    assert.equal(session.identity, undefined)
    assert.equal(other.reserved, undefined)
    assert.deepEqual(page.errors, [])
})

test('an end without an entry on a session that is no longer current still ends its reservation', async () => {
    const { page, session } = await start(35)
    const reservation = page.flusher.reserveSave()!
    const other = begin(page)
    assert.equal(await page.flusher.endSave(reservation, undefined, undefined, true), 'kept')
    assert.equal(session.reserved, undefined)
    // The new session is reserved on its own.
    const later = page.flusher.reserveSave()!
    assert.equal(later.session, other)
    assert.equal(await page.flusher.endSave(reservation), 'ended')
    assert.equal(other.reserved, later)
})

test('a second end of the same reservation returns ended and leaves nextSeq', async () => {
    const { page, session } = await start(36)
    const reservation = page.flusher.reserveSave()!
    assert.equal(await page.flusher.endSave(reservation), 'letGo')
    const next = session.nextSeq
    assert.equal(await page.flusher.endSave(reservation), 'ended')
    assert.equal(await page.flusher.endSave(reservation, undefined, undefined, true), 'ended')
    assert.equal(await page.flusher.endSave(reservation, saveEntry(reservation.wall)), 'ended')
    assert.equal(session.nextSeq, next)
    assert.equal(session.pending.length, 0)
    assert.equal(session.identity, undefined)
})

test('a stale reservation never ends a later one that reused its seq (ADV-5)', async () => {
    const { page, session } = await start(37)
    const first = page.flusher.reserveSave()!
    assert.equal(await page.flusher.endSave(first), 'letGo')
    const second = page.flusher.reserveSave()!
    assert.equal(second.seq, first.seq, 'the let-go seq was handed out again')
    assert.notEqual(second, first)
    assert.equal(await page.flusher.endSave(first, undefined, undefined, true), 'ended')
    assert.equal(await page.flusher.release(first), 'ended')
    assert.equal(session.reserved, second, 'the later Save still holds its reservation')
    assert.equal(session.nextSeq, second.seq + 1)
    assert.equal(page.flusher.reserveSave(), undefined, 'and no third is handed out')
    assert.equal(await page.flusher.endSave(second, saveEntry(second.wall)), 'added')
})

test('release keeps a reservation no path ended, once', async () => {
    const { page, session } = await start(38)
    const reservation = page.flusher.reserveSave()!
    assert.equal(await page.flusher.release(reservation), 'kept')
    assert.equal(session.nextSeq, 3)
    assert.equal(session.reserved, undefined)
    assert.equal(await page.flusher.release(reservation), 'ended')
    assert.equal(session.nextSeq, 3)
    // An end that already happened is not undone by a release.
    const done = page.flusher.reserveSave()!
    assert.equal(await page.flusher.endSave(done, saveEntry(done.wall)), 'added')
    assert.equal(await page.flusher.release(done), 'ended')
})
