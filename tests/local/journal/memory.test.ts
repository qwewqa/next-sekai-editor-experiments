import assert from 'node:assert/strict'
import test from 'node:test'
import type { JournalV1 } from '../../../src/local/journal/format'
import type { MemoryStorage } from '../../../src/local/journal/store'
import { checkStored } from '../../../src/local/testing/invariants'
import { CI_SEEDS, createWorld, type World } from '../../../src/local/testing/world'
import { goldenChart, stateOf } from '../records/charts'
import { widen } from '../timeline/helpers'
import { append, beginSession, openSplitJournalPage, replayAll } from './harness'

// The journal while storage is unavailable (§1.6.7): the worker's in-memory store acknowledges
// flushes, but only the journal survives the tab, so every hide writes it at the newest seq, and
// it's never cleared until a database commits strictly. From the start, after a worker restart
// into memory, and after Try Again's move into the database.

const settle = async (world: World) => {
    await world.clock.run()
    await world.idle()
}

const journalIn = (storage: MemoryStorage, sessionId: string) => {
    const text = storage.getItem(`nse.journal.${sessionId}`)
    return text === null ? undefined : (JSON.parse(text) as JournalV1)
}

test('in memory from the start, every hide journals the newest seq, never cleared', async () => {
    const world = createWorld({ seed: 1 })
    const page = await openSplitJournalPage(world, { flags: { noStorage: true } })
    assert.deepEqual(page.status, { mode: 'memory' })
    let state = stateOf(goldenChart())
    const session = beginSession(page, state)
    await page.flusher.flush()
    for (let i = 0; i < 3; i++) {
        state = widen(state, i)
        append(page, 'edit', 'Changed note', state)
        // The in-memory store acknowledges it; the journal is still due.
        await page.flusher.flush({ strict: true })
        assert.equal(page.flusher.hasPending, false)
        assert.equal(page.flusher.unflushed(session), true)
        assert.equal(page.writer.write(), true)
        const journal = journalIn(page.storage, session.id)
        assert.equal(journal?.seq, i + 2, `edit ${i}`)
        assert.equal(journal?.stack.keep, 0)
        assert.deepEqual(journal?.stack.head, { label: 'Changed note' })
    }
    // A strict flush into memory never clears it.
    await page.flusher.flush({ strict: true })
    assert.equal(journalIn(page.storage, session.id)?.seq, 4)

    // The next load with storage working recovers the session from it.
    const { outcomes } = await replayAll(world, page.storage)
    assert.equal(outcomes[0]?.kind, 'applied')
    assert.deepEqual(checkStored(world.memory), [])
})

test('after a worker restart into memory, hides journal the entries only memory holds', async () => {
    const world = createWorld({ seed: 2 })
    const flags: { noStorage?: boolean } = {}
    const page = await openSplitJournalPage(world, { flags })
    assert.deepEqual(page.status, { mode: 'stored' })
    let state = stateOf(goldenChart())
    const session = beginSession(page, state)
    state = widen(state)
    append(page, 'edit', 'Changed note', state)
    await page.flusher.flush({ strict: true })
    assert.equal(page.flusher.unflushed(session), false)

    // The worker dies and comes back over memory: storage is unavailable from now on.
    flags.noStorage = true
    page.host.worker.kill()
    await settle(world)
    assert.equal(page.host.core.status.mode, 'memory')
    state = widen(state, 1)
    append(page, 'edit', 'Changed note', state)
    await page.flusher.flush({ strict: true })
    assert.equal(page.flusher.hasPending, false)
    assert.equal(page.flusher.unflushed(session), true)
    assert.equal(page.writer.write(), true)
    const journal = journalIn(page.storage, session.id)
    assert.equal(journal?.seq, 3)
    assert.equal(journal?.stack.keep, 0)
})

test('after Try Again’s move the journal stays until a strict commit, and the stack follows lastSeq', async () => {
    for (const seed of CI_SEEDS.slice(0, 4)) {
        const world = createWorld({ seed })
        const frozen = world.tab('frozen')
        const { workerCore } = await import('../flush/harness')
        const frozenCore = workerCore(world, frozen, { flags: { ignoreVersionChange: true } })
        await frozen.run(() => frozenCore.start())
        // A v2 tab behind the frozen v1 tab runs in memory.
        const opening = openSplitJournalPage(world, { flags: { dbVersion: 2 } })
        await world.clock.run()
        const page = await opening
        assert.deepEqual(page.status, { mode: 'memory', reason: 'olderTabs' })
        let state = stateOf(goldenChart())
        const session = beginSession(page, state)
        await page.flusher.flush()
        state = widen(state)
        append(page, 'edit', 'Changed note', state)
        await page.flusher.flush()
        assert.equal(page.writer.write(), true)
        assert.equal(journalIn(page.storage, session.id)?.seq, 2, `seed ${seed}`)

        // The frozen tab goes; Try Again moves the in-memory rows into the database.
        frozen.kill()
        await world.idle()
        const trying = page.host.call((_, core) => core.tryAgain())
        await settle(world)
        assert.deepEqual(await trying, { mode: 'stored' }, `seed ${seed}`)
        // Moved, but not by a flush of this page: the journal is still due.
        assert.equal(page.flusher.unflushed(session), true)

        // The first flush into the database: its stack is the whole window, never one left
        // behind lastSeq, and a relaxed commit leaves the key.
        state = widen(state, 1)
        append(page, 'edit', 'Changed note', state)
        const before = page.results.length
        await page.flusher.flush()
        assert.deepEqual(page.errors, [], `seed ${seed}`)
        assert.deepEqual(checkStored(world.memory), [], `seed ${seed}`)
        // The blocks it left alone were memory's: sent again whole, written, never removed.
        const results = page.results.slice(before)
        assert.deepEqual(
            results.map((result) => result.kind),
            ['stackWhole', 'stored'],
            `seed ${seed}`,
        )
        const stored = results.at(-1)
        assert.ok(stored?.kind === 'stored' && stored.stackWritten && !stored.stackRemoved)
        assert.equal(page.writer.write(), true)
        assert.equal(journalIn(page.storage, session.id)?.seq, 3, `seed ${seed}`)
        // A strict one clears it.
        await page.flusher.flush({ strict: true })
        assert.equal(journalIn(page.storage, session.id), undefined, `seed ${seed}`)
        assert.equal(page.flusher.unflushed(session), false)
    }
})

test('a strict sync after a worker restart into memory covers nothing the database holds relaxed', async () => {
    const world = createWorld({ seed: 3 })
    const flags: { noStorage?: boolean } = {}
    const page = await openSplitJournalPage(world, { flags })
    let state = stateOf(goldenChart())
    const session = beginSession(page, state)
    await page.flusher.flush({ strict: true })
    // An idle relaxed flush: the database holds edit 2, not yet strictly.
    state = widen(state)
    append(page, 'edit', 'Changed note', state)
    await page.flusher.flush()
    assert.ok(session.ackedSeq > session.strictSeq)
    // The worker comes back over memory; the hide's journal, then its strict flush.
    flags.noStorage = true
    page.host.worker.kill()
    await settle(world)
    assert.equal(page.host.core.status.mode, 'memory')
    assert.equal(page.writer.write(), true)
    await page.flusher.flush({ strict: true })
    // The sync committed in memory only: the key stays, and nothing counts as strict.
    assert.equal(journalIn(page.storage, session.id)?.seq, 2)
    assert.ok(session.ackedSeq > session.strictSeq)
    assert.equal(page.flusher.syncFailed, true)
})
