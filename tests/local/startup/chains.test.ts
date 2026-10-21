import assert from 'node:assert/strict'
import test from 'node:test'
import type { FlushSession } from '../../../src/local/flush'
import { toHex } from '../../../src/local/hash'
import { sessionLock } from '../../../src/local/locks'
import { holdParentLock, holdSessionLock, TabClient } from '../../../src/local/sessions'
import { claimSessionLock } from '../../../src/local/startup/tab'
import { checkStored, checkStrict } from '../../../src/local/testing/invariants'
import { CI_SEEDS, createWorld, type World } from '../../../src/local/testing/world'
import { replay, stackMismatches } from '../../../src/local/timeline'
import { editStep, futureFixtureOperation, originOperation } from '../../helpers/historySteps'
import { openPage, openSplitPage, rows, testId, workerCore, type Page } from '../flush/harness'
import { goldenChart, stateOf } from '../records/charts'
import { storedEntries, storedStack, widen } from '../timeline/helpers'
import { beginIn, continueIn, handlersOf, readOpen, resumeIn } from './harness'

// Session chains on the test core (Part 1 §1.3.1, §1.11.4's exit): a continuation's first write
// moves the chain's head by compare-and-set, the race turning into a fork; forks copy the record
// by exclusion with new ids, a "(2)" name and no binding; a reload takes its session up again.

/** A page with a stored session of two states (an import, then an edit). */
const storedSession = async (world: World, name = 'first') => {
    const page = await openPage(world, world.tab(name))
    const a = stateOf(goldenChart())
    const b = widen(a)
    const session = beginIn(page, a)
    page.flusher.append(
        { kind: 'edit', step: editStep(futureFixtureOperation('Widened')) },
        b,
        true,
    )
    await page.flusher.flush({ strict: true })
    assert.deepEqual(page.errors, [])
    return { page, session, states: { a, b } }
}

const kinds = (world: World, sessionId: string) =>
    storedEntries(world, sessionId).map((entry) => `${entry.seq} ${entry.kind}`)

const heldShared = async (page: Page, sessionId: string) =>
    (await page.tab.locks.query()).held.some(
        (lock) => lock.name === sessionLock(sessionId) && lock.mode === 'shared',
    )

test('a continuation stores nothing until its first edit, which moves the chain’s head from its parent', async () => {
    const world = createWorld({ seed: 1 })
    const { session: parent, states } = await storedSession(world)
    const page = await openPage(world, world.tab('next'))
    const read = await readOpen(page, parent.id)
    assert.equal(read.isHead, true)
    const lock = holdParentLock(page.tab.locks, parent.id)
    await page.tab.run(() => lock.granted)
    const session = continueIn(page, read, { parentLock: lock })
    assert.equal(session.origin, 'continued')
    assert.equal(session.chainId, parent.chainId)

    // Continuing without editing adds nothing (§1.3.6), and the parent counts as open meanwhile.
    await page.flusher.flush()
    assert.equal(rows(world, 'sessions').has(session.id), false)
    assert.equal(page.flusher.unflushed(session), false)
    assert.equal(await heldShared(page, parent.id), true)

    const c = widen(states.b, 1)
    page.flusher.append(
        { kind: 'edit', step: editStep(futureFixtureOperation('Widened again')) },
        c,
        true,
    )
    await page.flusher.flush()
    assert.deepEqual(page.errors, [])
    const row = rows(world, 'sessions').get(session.id)
    assert.ok(row)
    assert.equal(row.chainId, parent.chainId)
    assert.equal(row.origin, 'continued')
    assert.deepEqual(row.parent, { id: parent.id, uptoSeq: 2 })
    assert.ok(
        (row.startedAt as number) > (rows(world, 'sessions').get(parent.id)?.updatedAt as number),
    )
    assert.deepEqual(kinds(world, session.id), ['1 continue', '2 edit'])
    // The continue entry points at the parent's head.
    const parentHead = storedEntries(world, parent.id).at(-1)!.snapshot
    assert.equal(toHex(storedEntries(world, session.id)[0]!.snapshot), toHex(parentHead))
    // The head moved, compare-and-set; the hold on the parent went with the first write.
    assert.equal(rows(world, 'chains').get(parent.chainId)?.head, session.id)
    assert.equal(await heldShared(page, parent.id), false)
    // Its stack is the parent's, copied whole, plus the edit: replay through the parent link.
    const stack = storedStack(world, session.id)
    assert.equal(stack.slots?.length, 3)
    assert.deepEqual(checkStored(world.memory), [])
})

test('two tabs continuing one session at once: one continues the chain, the other is stored as a fork', async () => {
    for (const seed of CI_SEEDS) {
        const world = createWorld({ seed })
        const { session: parent, states } = await storedSession(world)
        const forks: FlushSession[] = []
        const pages = await Promise.all(
            ['b', 'c'].map((name) =>
                openPage(world, world.tab(name), {
                    onFork: (fork) => forks.push(fork),
                    forkName: () => 'Golden (2)',
                }),
            ),
        )
        const reads = await Promise.all(pages.map((page) => readOpen(page, parent.id)))
        const sessions = pages.map((page, i) => continueIn(page, reads[i]!))
        pages.forEach((page, i) =>
            page.flusher.append(
                { kind: 'edit', step: editStep(futureFixtureOperation(`Edit ${i}`)) },
                widen(states.b, i + 2),
                true,
            ),
        )
        await Promise.all(pages.map((page) => page.flusher.flush()))
        for (const page of pages) assert.deepEqual(page.errors, [], `seed ${seed}`)

        const chain = rows(world, 'chains').get(parent.chainId)
        const winner = sessions.findIndex((session) => session.id === chain?.head)
        assert.notEqual(winner, -1, `seed ${seed}: one continued the chain`)
        assert.equal(forks.length, 1, `seed ${seed}: the other forked`)
        const fork = forks[0]!
        const loser = pages[1 - winner]!
        assert.equal(loser.flusher.session, fork)
        const forkChain = rows(world, 'chains').get(fork.chainId)
        assert.ok(forkChain)
        assert.equal(forkChain.head, fork.id)
        assert.equal(forkChain.name, 'Golden (2)')
        assert.notEqual(forkChain.docId, chain?.docId)
        // The fork continues the same parent, with the inherited stack and its own edit.
        const forkRow = rows(world, 'sessions').get(fork.id)
        assert.deepEqual(forkRow?.parent, { id: parent.id, uptoSeq: 2 })
        assert.deepEqual(kinds(world, fork.id), ['1 continue', '2 edit'])
        assert.equal(rows(world, 'sessions').has(sessions[1 - winner]!.id), false)
        assert.deepEqual(checkStrict(world.memory), [], `seed ${seed}`)
    }
})

test('tab B continues the chain while tab A’s lock was lost: A’s next flush isn’t the head and forks', async () => {
    const world = createWorld({ seed: 3 })
    const forks: FlushSession[] = []
    const first = await openPage(world, world.tab('a'), { onFork: (fork) => forks.push(fork) })
    const a = stateOf(goldenChart())
    const session = beginIn(first, a)
    await first.flusher.flush()
    // A's lock was lost (a hung tab): B continues the chain meanwhile.
    const second = await openPage(world, world.tab('b'))
    const continuation = continueIn(second, await readOpen(second, session.id))
    second.flusher.append(
        { kind: 'edit', step: editStep(futureFixtureOperation('B')) },
        widen(a, 1),
        true,
    )
    await second.flusher.flush()
    assert.equal(rows(world, 'chains').get(session.chainId)?.head, continuation.id)

    first.flusher.append(
        { kind: 'edit', step: editStep(futureFixtureOperation('A')) },
        widen(a, 2),
        true,
    )
    await first.flusher.flush()
    assert.deepEqual(first.errors, [])
    assert.equal(forks.length, 1)
    const fork = forks[0]!
    assert.notEqual(fork.chainId, session.chainId)
    assert.deepEqual(rows(world, 'sessions').get(fork.id)?.parent, { id: session.id, uptoSeq: 1 })
    // B's continuation keeps the chain; A's session stays as it was stored.
    assert.equal(rows(world, 'chains').get(session.chainId)?.head, continuation.id)
    assert.equal(rows(world, 'sessions').get(session.id)?.lastSeq, 1)
    assert.deepEqual(checkStored(world.memory), [])
})

test('a seeded chain record’s unknown field: a continuation keeps it, and a fork’s record carries it without the binding', async () => {
    const world = createWorld({ seed: 4 })
    const { session: parent, states } = await storedSession(world)
    const other = world.tab('seeder')
    const core = workerCore(world, other)
    await other.run(() => core.start())
    await other.run(() =>
        core.write(['chains'], async (tx) => {
            const chain = (await tx.get('chains', parent.chainId)) as Record<string, unknown>
            await tx.put('chains', {
                ...chain,
                future: { carried: true },
                name: 'Golden',
                file: { name: 'golden.nxsp', event: 'saved', at: 1, hash: new Uint8Array(16) },
                // D17's two fields: Export's target opened, not exported to yet, and the
                // partial import's flag.
                exportTarget: { name: 'LevelData', opened: true },
                exportName: 'LevelData',
                partialImport: true,
                replaced: { by: 'x', at: 1, name: 'golden.nxsp' },
            })
        }),
    )

    // A continuation keeps the record as it is, unknown field and binding included.
    const page = await openPage(world, world.tab('next'))
    const continuation = continueIn(page, await readOpen(page, parent.id))
    page.flusher.append(
        { kind: 'edit', step: editStep(futureFixtureOperation('Edit')) },
        widen(states.b, 1),
        true,
    )
    await page.flusher.flush()
    const chain = rows(world, 'chains').get(parent.chainId)!
    assert.equal(chain.head, continuation.id)
    assert.deepEqual(chain.future, { carried: true })
    assert.equal((chain.file as { name: string }).name, 'golden.nxsp')
    assert.deepEqual(chain.exportTarget, { name: 'LevelData', opened: true })
    assert.equal(chain.partialImport, true)

    // A fork copies it by exclusion: the unknown field carries; the binding and its kin don't.
    const third = await openPage(world, world.tab('third'))
    const fork = continueIn(third, await readOpen(third, continuation.id), { asFork: true })
    third.flusher.append(
        { kind: 'edit', step: editStep(futureFixtureOperation('Edit')) },
        widen(states.b, 2),
        true,
    )
    await third.flusher.flush()
    assert.deepEqual(third.errors, [])
    const forked = rows(world, 'chains').get(fork.chainId)!
    assert.equal(forked.head, fork.id)
    assert.deepEqual(forked.future, { carried: true })
    assert.equal(forked.partialImport, true)
    assert.equal(forked.name, 'Golden (2)')
    for (const field of ['file', 'exportTarget', 'exportName', 'replaced'])
        assert.equal(field in forked, false, field)
    assert.equal(forked.edited, true)
    assert.equal(forked.lineageId, chain.lineageId)
    assert.notEqual(forked.docId, chain.docId)
    // The original chain is untouched by the fork.
    assert.equal(rows(world, 'chains').get(parent.chainId)?.head, continuation.id)
    assert.deepEqual(checkStored(world.memory), [])
})

test('a continuation of a 20,000-step stack copies about 20 block rows', async () => {
    const world = createWorld({ seed: 5 })
    const first = await openPage(world, world.tab('a'))
    const a = stateOf(goldenChart())
    const b = widen(a)
    const session = beginIn(first, a)
    for (let i = 1; i < 20_000; i++)
        first.flusher.append(
            { kind: 'edit', step: editStep(futureFixtureOperation(`Edit ${i}`)) },
            i % 2 ? b : a,
            true,
        )
    await first.flusher.flush()
    assert.deepEqual(first.errors, [])

    const page = await openPage(world, world.tab('b'))
    const read = await readOpen(page, session.id)
    assert.equal(read.stack.window.length, 5000)
    assert.equal(read.stack.blocks.length, 21)
    continueIn(page, read)
    page.flusher.append(
        { kind: 'edit', step: editStep(futureFixtureOperation('One more')) },
        a,
        true,
    )
    await page.flusher.flush()
    assert.deepEqual(page.errors, [])
    const copied = page.reports.at(-1)!.stats.rowsByStore.stackBlocks ?? 0
    assert.equal(copied, 21)
    // The next edit rewrites one block, as any flush does.
    page.flusher.append(
        { kind: 'edit', step: editStep(futureFixtureOperation('And another')) },
        b,
        true,
    )
    await page.flusher.flush()
    assert.equal(page.reports.at(-1)!.stats.rowsByStore.stackBlocks, 1)
    assert.deepEqual(checkStored(world.memory), [])
})

test('a reload takes its session up again: no new row, and its next entry follows its last', async () => {
    const world = createWorld({ seed: 6 })
    const { session, states } = await storedSession(world)
    const page = await openPage(world, world.tab('reloaded'))
    const read = await readOpen(page, session.id)
    const resumed = resumeIn(page, read)
    assert.equal(resumed.id, session.id)
    await page.flusher.flush()
    assert.equal(page.batches.length, 0)
    page.flusher.append(
        { kind: 'edit', step: editStep(futureFixtureOperation('After reload')) },
        widen(states.b, 1),
        true,
    )
    await page.flusher.flush()
    assert.deepEqual(page.errors, [])
    assert.equal(rows(world, 'sessions').size, 1)
    assert.deepEqual(kinds(world, session.id), ['1 init', '2 edit', '3 edit'])
    // The stored blocks were read back: the flush rewrites only the one it touches.
    assert.equal(page.reports.at(-1)!.stats.rowsByStore.stackBlocks, 1)
    const stored = storedStack(world, session.id)
    assert.deepEqual(stackMismatches(stored, replay(storedEntries(world, session.id))), [])
    assert.deepEqual(checkStored(world.memory), [])
})

test('chain fields: an unstored continuation commits its first row with them, and a stored session writes them as the head', async () => {
    const world = createWorld({ seed: 7 })
    const { session: parent } = await storedSession(world)
    const page = await openPage(world, world.tab('next'), {
        writeChain: (request) => page.tab.run(() => handlersOf(page).writeChainFields(request)),
    })
    const continuation = continueIn(page, await readOpen(page, parent.id))
    assert.equal(await page.flusher.setChainFields({ exportName: 'Mine' }), true)
    const chain = () => rows(world, 'chains').get(parent.chainId)!
    // Stored with its `continue` entry alone, moving the head (§1.3.1).
    assert.equal(chain().head, continuation.id)
    assert.equal(chain().exportName, 'Mine')
    assert.equal(await page.flusher.setChainFields({ exportName: undefined, name: 'Named' }), true)
    assert.equal('exportName' in chain(), false)
    assert.equal(chain().name, 'Named')
    assert.equal(page.flusher.session?.chain?.name, 'Named')
    assert.deepEqual(checkStored(world.memory), [])
})

test('chain fields from a session that isn’t the head any more go to a fork', async () => {
    const world = createWorld({ seed: 8 })
    const forks: FlushSession[] = []
    const first = await openPage(world, world.tab('a'), {
        onFork: (fork) => forks.push(fork),
        writeChain: (request) => first.tab.run(() => handlersOf(first).writeChainFields(request)),
    })
    const a = stateOf(goldenChart())
    const session = beginIn(first, a)
    await first.flusher.flush()
    const second = await openPage(world, world.tab('b'))
    continueIn(second, await readOpen(second, session.id))
    second.flusher.append(
        { kind: 'edit', step: editStep(futureFixtureOperation('B')) },
        widen(a),
        true,
    )
    await second.flusher.flush()

    assert.equal(await first.flusher.setChainFields({ exportName: 'Late' }), false)
    await first.flusher.flush()
    assert.equal(forks.length, 1)
    const forked = rows(world, 'chains').get(forks[0]!.chainId)
    assert.equal(forked?.exportName, 'Late')
    assert.equal(rows(world, 'chains').get(session.chainId)?.exportName, undefined)
    assert.deepEqual(checkStored(world.memory), [])
})

test('a worker killed mid-flush in one tab: another tab’s load can’t continue the session while the lock is held', async () => {
    const world = createWorld({ seed: 9 })
    const page = await openSplitPage(world, { name: 'a' })
    const a = stateOf(goldenChart())
    const session = page.flusher.begin({
        id: testId(),
        docId: testId(),
        origin: 'import',
        state: a,
        operation: originOperation('import'),
        dirty: false,
    })
    // The page holds its session's lock on the main thread (r12-arch-web H3).
    const lock = holdSessionLock(page.page.locks, session.id)
    await page.page.run(() => lock.granted)
    await page.flusher.flush()
    page.flusher.append(
        { kind: 'edit', step: editStep(futureFixtureOperation('Edit')) },
        widen(a),
        true,
    )
    const flushing = page.flusher.flush()
    page.host.worker.kill()

    // Another tab's new visit finds the session held: it neither takes it nor continues it.
    const other = world.tab('b')
    assert.equal(await other.run(() => claimSessionLock(other.locks, session.id)), undefined)
    assert.equal(
        await other.run(() => new TabClient(other.locks).heldElsewhere(sessionLock(session.id))),
        true,
    )
    await flushing
    await page.flusher.flush()
    assert.equal(page.flusher.hasPending, false)
    assert.deepEqual(kinds(world, session.id), ['1 init', '2 edit'])
    assert.deepEqual(checkStored(world.memory), [])
    lock.release()
})
