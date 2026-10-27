import assert from 'node:assert/strict'
import test from 'node:test'
import { notDurableReason } from '../../../src/local/durable'
import { createWorld } from '../../../src/local/testing/world'
import { editStep, futureFixtureOperation } from '../../helpers/historySteps'
import '../../helpers/lockChecks'
import { goldenChart, stateOf } from '../records/charts'
import { widen } from '../timeline/helpers'
import { append, beginSession, openJournalPage, type JournalPage } from './harness'

// The not-durably-stored predicate: false while storage is unavailable or paused, before
// the session row is written, after a failed flush, and while unflushed entries have no verified
// journal; true for an ordinary pending flush with a verified journal.

const inputs = (page: JournalPage) => ({
    status: page.core.status,
    flusher: page.flusher,
    journal: page.writer,
})

const start = async (seed: number) => {
    const world = createWorld({ seed })
    const page = await openJournalPage(world, 'a')
    const a = stateOf(goldenChart())
    beginSession(page, a, 'new')
    return { page, a }
}

test('a session is durably stored once flushed, or pending with a verified journal', async () => {
    const { page, a } = await start(1)
    append(page, { kind: 'edit', step: editStep(futureFixtureOperation('Changed note')) }, widen(a))
    // An edit before the first flush finished.
    assert.equal(notDurableReason(inputs(page)), 'notWritten')
    await page.flusher.flush({ strict: true })
    assert.equal(notDurableReason(inputs(page)), undefined)
    append(
        page,
        { kind: 'edit', step: editStep(futureFixtureOperation('Changed note')) },
        widen(a, 1),
    )
    // A pending flush with no journal written yet.
    assert.equal(notDurableReason(inputs(page)), 'journal')
    assert.equal(page.writer.write(), true)
    assert.equal(notDurableReason(inputs(page)), undefined)
})

test('a relaxed commit counts as stored, with no journal', async () => {
    const { page, a } = await start(6)
    append(page, { kind: 'edit', step: editStep(futureFixtureOperation('Changed note')) }, widen(a))
    await page.flusher.flush({ strict: true })
    append(
        page,
        { kind: 'edit', step: editStep(futureFixtureOperation('Changed note')) },
        widen(a, 1),
    )
    assert.equal(notDurableReason(inputs(page)), 'journal')
    // The routine flush about 1 s after the edit.
    await page.flusher.flush()
    assert.equal(notDurableReason(inputs(page)), undefined)
    // With localStorage full too: nothing is left for a journal to hold.
    page.storage.quota = 10
    assert.equal(notDurableReason(inputs(page)), undefined)
})

test("with localStorage full the journal can't be written, so the session isn't stored", async () => {
    const { page, a } = await start(2)
    append(page, { kind: 'edit', step: editStep(futureFixtureOperation('Changed note')) }, widen(a))
    await page.flusher.flush({ strict: true })
    page.storage.quota = 10
    append(
        page,
        { kind: 'edit', step: editStep(futureFixtureOperation('Changed note')) },
        widen(a, 1),
    )
    assert.equal(page.writer.write(), false)
    assert.equal(notDurableReason(inputs(page)), 'journal')
})

test('storage unavailable or paused is never durably stored', async () => {
    const { page } = await start(3)
    assert.equal(notDurableReason({ ...inputs(page), status: undefined }), 'unavailable')
    assert.equal(notDurableReason({ ...inputs(page), status: { mode: 'memory' } }), 'unavailable')
    assert.equal(notDurableReason({ ...inputs(page), status: { mode: 'readOnly' } }), 'unavailable')
    for (const reason of ['full', 'failed', 'upgrading'] as const)
        assert.equal(
            notDurableReason({ ...inputs(page), status: { mode: 'stored', reason } }),
            'paused',
        )
})

test("a failed flush with unflushed entries isn't durably stored, whatever the journal", async () => {
    const { page, a } = await start(4)
    append(page, { kind: 'edit', step: editStep(futureFixtureOperation('Changed note')) }, widen(a))
    await page.flusher.flush({ strict: true })
    append(
        page,
        { kind: 'edit', step: editStep(futureFixtureOperation('Changed note')) },
        widen(a, 1),
    )
    page.writer.write()
    page.flusher.failed = true
    assert.equal(notDurableReason(inputs(page)), 'flushFailed')
})

test("the head's media the store refused leaves the session not durably stored", async () => {
    const { page, a } = await start(5)
    append(page, { kind: 'edit', step: editStep(futureFixtureOperation('Changed BGM')) }, widen(a))
    await page.flusher.flush({ strict: true })
    const hash = 'ab'.repeat(16)
    const status = { mode: 'stored' as const, mediaPending: [hash] }
    assert.equal(notDurableReason({ ...inputs(page), status, media: [hash] }), 'mediaPending')
    // Media the head no longer holds doesn't count.
    assert.equal(notDurableReason({ ...inputs(page), status, media: [] }), undefined)
})
