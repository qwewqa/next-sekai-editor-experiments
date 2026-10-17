import assert from 'node:assert/strict'
import test from 'node:test'
import type { JournalV1 } from '../../../src/local/journal/format'
import { createWorld } from '../../../src/local/testing/world'
import { rows } from '../flush/harness'
import { goldenChart, stateOf } from '../records/charts'
import { widen } from '../timeline/helpers'
import { append, beginSession, openJournalPage } from './harness'

// A flush that writes a session's last entry without a stack the worker can use removes the
// stored stack rather than leave one behind `lastSeq` (§1.3.9: replay rebuilds a missing one):
// the page forgets its window, the journal keeps nothing, and the next flush writes it whole.

test('entries the stack model can’t follow remove the stored stack, and the next flush writes it whole', async () => {
    const world = createWorld({ seed: 1 })
    const page = await openJournalPage(world, 'a')
    const a = stateOf(goldenChart())
    const session = beginSession(page, a)
    const b = widen(a)
    append(page, 'edit', 'Changed note', b)
    await page.flusher.flush({ strict: true })
    assert.ok(rows(world, 'sessions').get(session.id)?.stack)
    // An undo past the bottom of the stack: a bug the model can't follow.
    append(page, 'undo', 'Changed note', a)
    append(page, 'undo', 'Changed note', a)
    await page.flusher.flush({ strict: true })
    const result = page.results.at(-1)
    assert.ok(result?.kind === 'stored' && result.stackRemoved && !result.stackWritten)
    assert.equal(rows(world, 'sessions').get(session.id)?.stack, undefined)
    assert.equal(
        [...rows(world, 'stackBlocks').values()].filter((row) => row.sessionId === session.id)
            .length,
        0,
    )
    assert.equal(session.stack.window, undefined)
    // A journal now keeps nothing of a stack that isn't stored.
    append(page, 'edit', 'Moved notes', widen(b, 1))
    assert.equal(page.writer.write(), true)
    const journal = JSON.parse(page.storage.getItem(`nse.journal.${session.id}`) ?? '') as JournalV1
    assert.equal(journal.stack.keep, 0)
    // The next flush stores the window whole.
    await page.flusher.flush({ strict: true })
    assert.equal(page.batches.at(-1)?.stack?.full, true)
    assert.ok(rows(world, 'sessions').get(session.id)?.stack)
})
