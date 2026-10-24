import assert from 'node:assert/strict'
import test from 'node:test'
import { createWorld, type World } from '../../../src/local/testing/world'
import { readTimeline } from '../../../src/local/worker/timelineHandlers'
import { editStep, futureFixtureOperation } from '../../helpers/historySteps'
import '../../helpers/lockChecks'
import { workerCore } from '../flush/harness'
import { append, openJournalPage } from '../journal/harness'
import { continueIn, readOpen } from '../startup/harness'
import { widen } from '../timeline/helpers'
import { closedChain, MemoryStorage, openDeleter } from './harness'

// The end of the Timeline: the oldest stored session of a chain that continues
// a session no longer stored ends the Timeline with the report `earlierMissing`; a chain whose
// oldest session starts it does not.

const read = async (world: World, sessionId: string, limit = 100, before?: number) => {
    const tab = world.tab(`timeline-${String(Math.random())}`)
    const core = workerCore(world, tab)
    await tab.run(() => core.start())
    return tab.run(() =>
        core.read(['chains', 'sessions', 'entries', 'nodes'], (tx) =>
            readTimeline(tx, { sessionId, limit, ...(before === undefined ? {} : { before }) }),
        ),
    )
}

/** A chain of two sessions, and a fork of its head with one edit of its own. */
const forkOfClosed = async (world: World, storage: MemoryStorage) => {
    const { first, second, states } = await closedChain(world, storage)
    const page = await openJournalPage(world, `forker-${String(Math.random())}`, storage)
    const fork = continueIn(page, await readOpen(page, second.id), { asFork: true })
    append(
        page,
        { kind: 'edit', step: editStep(futureFixtureOperation('Forked edit')) },
        widen(states.b, 3),
    )
    await page.flusher.flush({ strict: true })
    page.tab.kill()
    await world.idle()
    return { first, second, fork }
}

test('a Timeline that reaches the start of its chain has no missing parent', async () => {
    const world = createWorld({ seed: 31 })
    const { first, second } = await closedChain(world, new MemoryStorage())
    const page = await read(world, second.id)
    assert.equal(page.earlierMissing, undefined)
    assert.equal(page.next, undefined)
    assert.ok(page.entries.some((entry) => entry.sessionId === first.id))
})

test('a fork whose parent chain was deleted ends at its divider and reports the missing parent', async () => {
    const world = createWorld({ seed: 32 })
    const storage = new MemoryStorage()
    const { first, second, fork } = await forkOfClosed(world, storage)
    // Before the parent chain goes, the fork's Timeline runs on into it.
    const before = await read(world, fork.id)
    assert.equal(before.earlierMissing, undefined)
    assert.ok(before.entries.some((entry) => entry.sessionId === second.id))
    const deleter = await openDeleter(world, world.tab('b'), storage)
    assert.equal((await deleter.mark(first.chainId)).kind, 'marked')
    assert.deepEqual(await deleter.sweep(), { removed: 1, busy: false })
    const page = await read(world, fork.id)
    assert.equal(page.earlierMissing, true)
    assert.equal(page.next, undefined)
    assert.ok(page.entries.every((entry) => entry.sessionId === fork.id))
    // The fork's first entry is its divider, which has no time of the entry it continued.
    const oldest = page.entries.at(-1)
    assert.equal(oldest?.kind, 'continue')
    assert.equal(oldest?.from, undefined)
})

test('the report comes with the page that ends the chain, not one that fills before it', async () => {
    const world = createWorld({ seed: 33 })
    const storage = new MemoryStorage()
    const { first, fork } = await forkOfClosed(world, storage)
    const deleter = await openDeleter(world, world.tab('b'), storage)
    assert.equal((await deleter.mark(first.chainId)).kind, 'marked')
    await deleter.sweep()
    const all = await read(world, fork.id)
    // A page that fills before the end has a next page; the one that finds no more entries
    // reports the missing parent, however many empty pages came before it.
    for (const limit of [all.entries.length, all.entries.length - 1]) {
        const page = await read(world, fork.id, limit)
        assert.equal(page.earlierMissing, undefined, `limit ${String(limit)}`)
        assert.ok(page.next)
        const rest = await read(world, page.next.sessionId, 100, page.next.before)
        assert.equal(rest.earlierMissing, true, `limit ${String(limit)}`)
        assert.equal(rest.next, undefined)
    }
})
