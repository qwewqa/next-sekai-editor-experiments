import assert from 'node:assert/strict'
import test from 'node:test'
import { importLock, sessionLock } from '../../../src/local/locks'
import { listRecent, readRecent } from '../../../src/local/recent'
import { SESSION_V } from '../../../src/local/records/version'
import { checkStored } from '../../../src/local/testing/invariants'
import { createWorld } from '../../../src/local/testing/world'
import { maintHandlers } from '../../../src/local/worker/maintHandlers'
import { editStep, futureFixtureOperation } from '../../helpers/historySteps'
import '../../helpers/lockChecks'
import { openPage, rows, workerCore } from '../flush/harness'
import { continueIn, handlersOf, readOpen } from '../startup/harness'
import { widen } from '../timeline/helpers'
import { closedChain, MemoryStorage, openDeleter, tamper, visible, WALL } from './harness'

// Delete, Undo and the sweep, by the rules of docs/history-format.md: R3 (lock every session or skip),
// R4 (whole and ordered), R5 (journals first, never swept unseen), R8 and R9.

const chainRows = (world: ReturnType<typeof createWorld>, chainId: string) => ({
    chain: rows(world, 'chains').get(chainId),
    sessions: [...rows(world, 'sessions').values()].filter((row) => row.chainId === chainId),
})

test('Delete marks and hides a chain, the sweep removes it whole once the mark is old enough', async () => {
    const world = createWorld({ seed: 1 })
    const storage = new MemoryStorage()
    const { first, second } = await closedChain(world, storage)
    const deleter = await openDeleter(world, world.tab('b'), storage)
    const marked = await deleter.mark(first.chainId)
    assert.equal(marked.kind, 'marked')
    if (marked.kind !== 'marked') return
    assert.deepEqual(deleter.due, [marked.mark.at + 10 * 60 * 1000])
    assert.equal(deleter.updates.count, 1)
    assert.deepEqual(await visible(world, first.chainId), { opens: false, newest: false })
    // A second press on a marked chain is gone, never open.
    assert.equal((await deleter.mark(first.chainId)).kind, 'gone')
    // Too young for the sweep.
    assert.deepEqual(await deleter.sweep(10 * 60 * 1000), { removed: 0, busy: false })
    assert.ok(chainRows(world, first.chainId).chain)
    deleter.clock.wall = WALL + 10 * 60 * 1000
    assert.deepEqual(await deleter.sweep(10 * 60 * 1000), { removed: 1, busy: false })
    const left = chainRows(world, first.chainId)
    assert.equal(left.chain, undefined)
    assert.deepEqual(left.sessions, [])
    for (const id of [first.id, second.id])
        assert.ok(![...rows(world, 'entries').values()].some((row) => row.sessionId === id))
    assert.deepEqual(checkStored(world.memory), [])
    await world.idle()
})

test('a chain is refused while any holder has one of its sessions, and never marked', async () => {
    const holders: [string, (id: string) => string, 'exclusive' | 'shared'][] = [
        ['an open session', sessionLock, 'exclusive'],
        ["an unstored continuation's hold on its parent", sessionLock, 'shared'],
        ["Recent Sessions' Save…'s hold", sessionLock, 'shared'],
        ['an import', importLock, 'exclusive'],
    ]
    for (const [what, lock, mode] of holders) {
        const world = createWorld({ seed: 2 })
        const storage = new MemoryStorage()
        const { first, second } = await closedChain(world, storage)
        const holder = world.tab('holder')
        let release!: () => void
        const held = new Promise<void>((resolve) => (release = resolve))
        // The older session: every session of the chain counts, not only its head.
        void holder.run(() => holder.locks.request(lock(first.id), { mode }, () => held))
        await world.idle()
        const deleter = await openDeleter(world, world.tab('b'), storage)
        assert.equal((await deleter.mark(first.chainId)).kind, 'open', what)
        assert.equal(rows(world, 'chains').get(first.chainId)?.deleting, undefined, what)
        // No lock of the chain is left held by the refused Delete.
        assert.ok(!world.locks.holders().some((each) => each.actor === deleter.tab.actor), what)
        release()
        await world.idle()
        void second
    }
})

test('a chain continued in another tab after Delete read it is refused as open', async () => {
    const world = createWorld({ seed: 3 })
    const storage = new MemoryStorage()
    const { first, second } = await closedChain(world, storage)
    const deleter = await openDeleter(world, world.tab('b'), storage)
    deleter.hooks.before = async (method) => {
        if (method !== 'markDeleting') return
        deleter.hooks.before = undefined
        world.checks.lock = false
        // Another tab's continuation stored its first write meanwhile: a new head.
        await tamper(world, async (tx) => {
            const head = (await tx.get('sessions', second.id)) as Record<string, unknown>
            await tx.put('sessions', { ...head, id: 'later', startedAt: WALL })
            const chain = (await tx.get('chains', first.chainId)) as Record<string, unknown>
            await tx.put('chains', { ...chain, head: 'later' })
        })
        world.checks.lock = true
    }
    assert.equal((await deleter.mark(first.chainId)).kind, 'open')
    assert.equal(rows(world, 'chains').get(first.chainId)?.deleting, undefined)
})

test('Undo restores a chain the sweep has not removed, and says lost for one it has, in either order', async () => {
    for (const order of ['undoFirst', 'sweepFirst'] as const) {
        const world = createWorld({ seed: 4 })
        const storage = new MemoryStorage()
        const { first } = await closedChain(world, storage)
        const deleter = await openDeleter(world, world.tab('b'), storage)
        const marked = await deleter.mark(first.chainId)
        assert.equal(marked.kind, 'marked')
        if (marked.kind !== 'marked') return
        // Undo pressed before the sweep's transaction, or after it.
        const sweeper = await openDeleter(world, world.tab('c'), storage)
        const [undone, swept] =
            order === 'undoFirst'
                ? [await deleter.undo([marked.mark]), await sweeper.sweep()]
                : [undefined, await sweeper.sweep()]
        const late = undone ?? (await deleter.undo([marked.mark]))
        assert.equal(late.kind, 'done')
        if (late.kind !== 'done') return
        const chain = rows(world, 'chains').get(first.chainId)
        if (order === 'undoFirst') {
            assert.deepEqual(late, { kind: 'done', restored: [first.chainId], lost: [] })
            assert.equal(swept.removed, 0, 'the sweep finds no mark')
            assert.ok(chain && chain.deleting === undefined)
            assert.deepEqual(await visible(world, first.chainId), { opens: true, newest: true })
        } else {
            assert.deepEqual(late, { kind: 'done', restored: [], lost: [first.chainId] })
            assert.equal(chain, undefined)
        }
        assert.deepEqual(checkStored(world.memory), [])
        await world.idle()
    }
})

test('Undo clears only its own mark: a newer Delete of the same chain stays', async () => {
    const world = createWorld({ seed: 5 })
    const storage = new MemoryStorage()
    const { first } = await closedChain(world, storage)
    const deleter = await openDeleter(world, world.tab('b'), storage)
    const marked = await deleter.mark(first.chainId)
    assert.equal(marked.kind, 'marked')
    if (marked.kind !== 'marked') return
    assert.deepEqual((await deleter.undo([marked.mark])).kind, 'done')
    const again = await deleter.mark(first.chainId)
    assert.equal(again.kind, 'marked')
    // The first Delete's Undo, pressed late: its mark is gone, the second one stays.
    assert.deepEqual(await deleter.undo([marked.mark]), {
        kind: 'done',
        restored: [],
        lost: [first.chainId],
    })
    assert.notEqual(rows(world, 'chains').get(first.chainId)?.deleting, undefined)
})

test("Delete applies a crashed tab's journal before the mark: Undo shows that state, and nothing replays twice", async () => {
    const world = createWorld({ seed: 6 })
    const storage = new MemoryStorage()
    const { second } = await closedChain(world, storage, true)
    assert.equal(storage.length, 1)
    const deleter = await openDeleter(world, world.tab('b'), storage)
    const marked = await deleter.mark(second.chainId)
    assert.equal(marked.kind, 'marked')
    if (marked.kind !== 'marked') return
    // Applied under the Delete's locks, the key gone before the mark.
    assert.equal(storage.length, 0)
    const entries = [...rows(world, 'entries').values()].filter(
        (row) => row.sessionId === second.id,
    )
    assert.equal(entries.at(-1)?.kind, 'recovered')
    await deleter.undo([marked.mark])
    assert.deepEqual(await visible(world, second.chainId), { opens: true, newest: true })
    assert.equal(
        [...rows(world, 'entries').values()].filter((row) => row.sessionId === second.id).length,
        entries.length,
    )
    assert.deepEqual(checkStored(world.memory), [])
})

test('the sweep skips a chain with a journal; the next load makes it a recovery chain, and the sweep then removes the chain', async () => {
    const world = createWorld({ seed: 7 })
    const storage = new MemoryStorage()
    const { second } = await closedChain(world, storage, true)
    // The journal could not be applied: it stays, and the chain is marked all the same.
    const deleter = await openDeleter(world, world.tab('b'), storage, { replay: 'fail' })
    assert.equal((await deleter.mark(second.chainId)).kind, 'marked')
    assert.equal(storage.length, 1)
    assert.deepEqual(await deleter.sweep(), { removed: 0, busy: false })
    assert.ok(rows(world, 'chains').get(second.chainId))
    assert.equal(
        (
            await deleter.remove({
                chainId: second.chainId,
                locked: [...rows(world, 'sessions').values()]
                    .filter((row) => row.chainId === second.chainId)
                    .map((row) => String(row.id)),
                expect: { head: second.id, updatedAt: 0 },
                reason: 'deleteSessions',
            })
        ).kind,
        'journal',
    )
    // The next load: the journal becomes a chain of its own, never applied to the deleted one.
    const next = await openDeleter(world, world.tab('next'), storage)
    const { replayAll } = await import('../journal/harness')
    const { outcomes } = await replayAll(world, storage)
    assert.equal(outcomes[0]?.kind, 'recovery')
    assert.equal(storage.length, 0)
    assert.deepEqual(await next.sweep(), { removed: 1, busy: false })
    assert.equal(rows(world, 'chains').get(second.chainId), undefined)
    const recovered = [...rows(world, 'chains').values()]
    assert.equal(recovered.length, 1)
    assert.notEqual(recovered[0]?.chainId, second.chainId)
    assert.deepEqual(checkStored(world.memory), [])
})

test('a removal whose page holds no lock of the session breaks the lock rule', async () => {
    const world = createWorld({ seed: 8 })
    const storage = new MemoryStorage()
    const { first, second } = await closedChain(world, storage)
    const tab = world.tab('rogue')
    const core = workerCore(world, tab)
    await tab.run(() => core.start())
    const handlers = maintHandlers({ core, test: true, emit: () => undefined })
    const chain = rows(world, 'chains').get(first.chainId)!
    const result = await tab.run(() =>
        handlers.removeSessions({
            chainId: first.chainId,
            locked: [first.id, second.id],
            expect: { head: second.id, updatedAt: chain.updatedAt as number },
            reason: 'deleteSessions',
        }),
    )
    assert.equal(result.kind, 'removed')
    assert.ok(world.violations.some((violation) => violation.startsWith('lock: session')))
    world.violations.length = 0
})

test('removal re-reads what was locked: a changed head, session set or mark is refused', async () => {
    const world = createWorld({ seed: 9 })
    const storage = new MemoryStorage()
    const { first, second } = await closedChain(world, storage)
    const deleter = await openDeleter(world, world.tab('b'), storage)
    const updatedAt = rows(world, 'chains').get(first.chainId)?.updatedAt as number
    const base = {
        chainId: first.chainId,
        locked: [first.id, second.id],
        expect: { head: second.id, updatedAt },
        reason: 'deleteSessions' as const,
    }
    const refused = [
        { ...base, locked: [first.id] },
        { ...base, expect: { ...base.expect, head: first.id } },
        { ...base, expect: { ...base.expect, updatedAt: updatedAt - 1 } },
        // Delete's sweep only takes a chain carrying its mark.
        { ...base, reason: 'delete' as const },
    ]
    for (const request of refused)
        assert.equal((await deleter.remove(request)).kind, 'changed', JSON.stringify(request))
    assert.deepEqual(await deleter.remove(base), { kind: 'removed', sessions: 2 })
    assert.deepEqual(chainRows(world, first.chainId), { chain: undefined, sessions: [] })
    assert.equal(rows(world, 'meta').get('deletionsPending')?.value, true)
})

test('a chain whose head needs a newer version is deleted whole on request', async () => {
    const world = createWorld({ seed: 10 })
    const storage = new MemoryStorage()
    const { first, second } = await closedChain(world, storage)
    world.checks.lock = false
    await tamper(world, async (tx) => {
        const head = (await tx.get('sessions', second.id)) as Record<string, unknown>
        await tx.put('sessions', { ...head, v: SESSION_V + 1 })
    })
    world.checks.lock = true
    const deleter = await openDeleter(world, world.tab('b'), storage)
    assert.equal((await deleter.mark(first.chainId)).kind, 'marked')
    assert.deepEqual(await deleter.sweep(), { removed: 1, busy: false })
    assert.deepEqual(chainRows(world, first.chainId), { chain: undefined, sessions: [] })
})

test('a pending import of a chain marked for Delete is not resumed', async () => {
    const world = createWorld({ seed: 11 })
    const storage = new MemoryStorage()
    const { first, second } = await closedChain(world, storage)
    world.checks.lock = false
    await tamper(world, async (tx) => {
        const head = (await tx.get('sessions', second.id)) as Record<string, unknown>
        await tx.put('sessions', { ...head, importPending: true })
    })
    world.checks.lock = true
    const deleter = await openDeleter(world, world.tab('b'), storage)
    const pending = () => deleter.tab.run(() => deleter.worker.call('openPendingImports'))
    assert.deepEqual(await pending(), [{ sessionId: second.id, chainId: first.chainId }])
    assert.equal((await deleter.mark(first.chainId)).kind, 'marked')
    assert.deepEqual(await pending(), [])
})

test('a continuation whose chain is marked before its first write forks into a visible chain, and the sweep leaves it whole', async () => {
    const world = createWorld({ seed: 12 })
    const storage = new MemoryStorage()
    const { first, second, states } = await closedChain(world, storage)
    const page = await openPage(world, world.tab('a'))
    // The tab read the chain as the newest and continued it; it holds nothing of the chain yet.
    continueIn(page, await readOpen(page, second.id))
    const deleter = await openDeleter(world, world.tab('b'), storage)
    assert.equal((await deleter.mark(first.chainId)).kind, 'marked')
    page.flusher.append(
        { kind: 'edit', step: editStep(futureFixtureOperation('After the mark')) },
        widen(states.b, 3),
        true,
    )
    await page.flusher.flush({ strict: true })
    const forked = [...rows(world, 'chains').keys()].filter((id) => id !== first.chainId)
    assert.equal(forked.length, 1)
    assert.equal(rows(world, 'chains').get(first.chainId)?.head, second.id)
    const handlers = handlersOf(page)
    const list = await listRecent({ call: () => page.tab.run(() => handlers.listRecent()) })
    assert.deepEqual(
        list.storedRead === 'value' ? list.storedValue.map((each) => each.chainId) : [],
        forked,
    )
    assert.deepEqual(await deleter.sweep(), { removed: 1, busy: false })
    assert.equal(rows(world, 'chains').get(first.chainId), undefined)
    assert.ok(rows(world, 'chains').get(forked[0] ?? ''))
    const head = String(rows(world, 'chains').get(forked[0] ?? '')?.head)
    assert.equal((await readOpen(page, head)).kind, 'open')
    assert.deepEqual(checkStored(world.memory), [])
    await world.idle()
})

test('a damaged chain (no head id, or a head with no session row) is Deleted and swept like any other', async () => {
    for (const damage of ['noHead', 'missingHead'] as const) {
        const world = createWorld({ seed: 12 })
        const storage = new MemoryStorage()
        const { first, second } = await closedChain(world, storage)
        world.checks.lock = false
        await tamper(world, async (tx) => {
            const chain = (await tx.get('chains', first.chainId)) as Record<string, unknown>
            const rest = { ...chain }
            delete rest.head
            await tx.put('chains', damage === 'noHead' ? rest : { ...rest, head: 'vanished' })
        })
        world.checks.lock = true
        const deleter = await openDeleter(world, world.tab('b'), storage)
        // Recent Sessions lists it as damaged; Delete from its row works all the same.
        const listed = await deleter.tab.run(() =>
            deleter.core.read(['chains', 'sessions', 'stackBlocks'], readRecent),
        )
        assert.equal(listed.find((each) => each.chainId === first.chainId)?.readable, 'damaged')
        const marked = await deleter.mark(first.chainId)
        assert.equal(marked.kind, 'marked', damage)
        if (marked.kind !== 'marked') return
        assert.equal(rows(world, 'chains').get(first.chainId)?.deleting !== undefined, true, damage)
        // Undo brings it back; marked again, the sweep removes it whole.
        assert.deepEqual(await deleter.undo([marked.mark]), {
            kind: 'done',
            restored: [first.chainId],
            lost: [],
        })
        assert.equal((await deleter.mark(first.chainId)).kind, 'marked', damage)
        assert.deepEqual(await deleter.sweep(), { removed: 1, busy: false }, damage)
        assert.deepEqual(chainRows(world, first.chainId), { chain: undefined, sessions: [] })
        for (const id of [first.id, second.id])
            assert.ok(![...rows(world, 'entries').values()].some((row) => row.sessionId === id))
        await world.idle()
    }
})
