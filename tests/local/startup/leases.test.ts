import assert from 'node:assert/strict'
import test from 'node:test'
import type { FlushSession } from '../../../src/local/flush'
import { sessionLock } from '../../../src/local/locks'
import { holdLock, lockLease, noLease, tryLease, type LockLease } from '../../../src/local/sessions'
import { createWorld } from '../../../src/local/testing/world'
import { editStep, futureFixtureOperation, originOperation } from '../../helpers/historySteps'
import { leaseOf } from '../../helpers/leases'
import '../../helpers/lockChecks'
import { openPage, rows, testId, type Page } from '../flush/harness'
import { goldenChart, stateOf } from '../records/charts'
import { widen } from '../timeline/helpers'
import { beginIn, continueIn, readOpen } from './harness'

// Lock leases: one owner at a time. A lease is released by its creator unless the
// flusher took it, and the flusher takes it only as a session registers.

/** A lease that counts how often its raw release runs. */
const counted = () => {
    const calls = { released: 0 }
    return {
        calls,
        lease: leaseOf(() => {
            calls.released++
        }),
    }
}

/** Begins a session holding `lock`, as a creator that passes it on does. */
const startWith = (page: Page, lock: LockLease) =>
    page.flusher.begin({
        id: testId(),
        docId: testId(),
        origin: 'import',
        state: stateOf(goldenChart()),
        operation: originOperation('import'),
        dirty: false,
        lock,
    })

/** A stored session of two states, and a second page to continue it in. */
const storedSession = async (seed: number) => {
    const world = createWorld({ seed })
    const first = await openPage(world, world.tab('first'))
    const a = stateOf(goldenChart())
    const session = beginIn(first, a)
    first.flusher.append(
        { kind: 'edit', step: editStep(futureFixtureOperation('Widened')) },
        widen(a),
        true,
    )
    await first.flusher.flush({ strict: true })
    const page = await openPage(world, world.tab('next'))
    const read = await readOpen(page, session.id)
    return { world, page, read, session, state: widen(a) }
}

test('a lease is taken once, released once, and never taken after it is released', () => {
    const { calls, lease } = counted()
    assert.equal(lease.state, 'held')
    const release = lease.take()
    assert.equal(lease.state, 'taken')
    // The creator's release leaves a taken lease alone.
    lease.release()
    assert.equal(calls.released, 0)
    assert.equal(lease.state, 'taken')
    assert.throws(() => lease.take())
    release()
    release()
    assert.equal(calls.released, 1)
    assert.equal(lease.state, 'released')
    assert.throws(() => lease.take())

    const plain = counted()
    plain.lease.release()
    plain.lease.release()
    assert.equal(plain.calls.released, 1)
    assert.equal(plain.lease.state, 'released')
    assert.throws(() => plain.lease.take())
})

test('a lease on a lock keeps it until the owner releases it, whoever that is', async () => {
    const world = createWorld({ seed: 1 })
    const tab = world.tab('a')
    const other = world.tab('b')
    const heldBy = async (name: string) =>
        (await tab.locks.query()).held.some((lock) => lock.name === name)
    const name = sessionLock('S')

    const created = holdLock(tab.locks, name)
    await tab.run(() => created.granted)
    assert.equal(await heldBy(name), true)
    created.release()
    await tab.run(() => Promise.resolve())
    assert.equal(await heldBy(name), false)

    // A taken lease is the taker's: the creator's release does nothing, the taker's frees it.
    const taken = holdLock(tab.locks, name)
    await tab.run(() => taken.granted)
    const release = taken.take()
    taken.release()
    await tab.run(() => Promise.resolve())
    assert.equal(await heldBy(name), true)
    release()
    await tab.run(() => Promise.resolve())
    assert.equal(await heldBy(name), false)

    // A request that is not granted is no lease; a granted one is.
    const first = await other.run(() => tryLease(other.locks, name, { ifAvailable: true }))
    assert.ok(first)
    assert.equal(await other.run(() => tryLease(tab.locks, name, { ifAvailable: true })), undefined)
    first.release()
    assert.equal(noLease(name).state, 'held')
    assert.equal(lockLease(name, Promise.resolve(), () => undefined).state, 'held')
})

test('a throw before the flusher takes a lease leaves it held, for its creator to release once', async () => {
    const world = createWorld({ seed: 2 })
    const page = await openPage(world, world.tab('a'))
    // A listener of the first entry throws before the session registers.
    const stop = page.flusher.onEntry(() => {
        throw new Error('The entry listener failed')
    })
    const { calls, lease } = counted()
    try {
        assert.throws(() => startWith(page, lease), /listener failed/)
    } finally {
        lease.release()
    }
    stop()
    assert.equal(lease.state, 'released')
    assert.equal(calls.released, 1)
    assert.equal(page.flusher.session, undefined)
})

test('a lease the flusher took is not released by its creator, and goes when the session ends', async () => {
    const world = createWorld({ seed: 3 })
    const page = await openPage(world, world.tab('a'))
    const { calls, lease } = counted()
    try {
        startWith(page, lease)
    } finally {
        lease.release()
    }
    assert.equal(lease.state, 'taken')
    assert.equal(calls.released, 0)
    beginIn(page, stateOf(goldenChart()))
    await page.flusher.flush({ strict: true })
    assert.equal(calls.released, 1)
    assert.equal(lease.state, 'released')
})

const registered = (page: Page): FlushSession | undefined => page.flusher.session

for (const lost of ['lock', 'parent'] as const) {
    test(`a continuation with its ${lost} lease lost takes neither, and registers nothing`, async () => {
        const { page, read } = await storedSession(lost === 'lock' ? 4 : 5)
        const own = counted()
        const parent = counted()
        // The lost one was released by a creator before the flusher got it.
        ;(lost === 'lock' ? own : parent).lease.release()
        assert.throws(() => continueIn(page, read, { lock: own.lease, parentLock: parent.lease }))
        const kept = lost === 'lock' ? parent : own
        assert.equal(kept.lease.state, 'held')
        assert.equal(kept.calls.released, 0)
        assert.equal(registered(page), undefined)
        kept.lease.release()
        assert.equal(kept.calls.released, 1)
        assert.equal((lost === 'lock' ? own : parent).calls.released, 1)
    })
}

test('a continuation takes both its leases, and its parent goes at the first write', async () => {
    const { world, page, read, state } = await storedSession(6)
    const own = counted()
    const parent = counted()
    const session = continueIn(page, read, { lock: own.lease, parentLock: parent.lease })
    assert.equal(own.lease.state, 'taken')
    assert.equal(parent.lease.state, 'taken')
    own.lease.release()
    parent.lease.release()
    assert.deepEqual([own.calls.released, parent.calls.released], [0, 0])
    page.flusher.append(
        { kind: 'edit', step: editStep(futureFixtureOperation('Again')) },
        widen(state, 1),
        true,
    )
    await page.flusher.flush({ strict: true })
    assert.equal(rows(world, 'sessions').has(session.id), true)
    assert.deepEqual([own.calls.released, parent.calls.released], [0, 1])
})

test('releaseParent lets go of the hold once, whenever it is called', async () => {
    const { world, page, read, state } = await storedSession(7)
    const own = counted()
    const parent = counted()
    // Started from a journal: the parent stays held past the first write.
    const session = continueIn(page, read, {
        lock: own.lease,
        parentLock: parent.lease,
        parentUntilReleased: true,
    })
    page.flusher.append(
        { kind: 'edit', step: editStep(futureFixtureOperation('Again')) },
        widen(state, 1),
        true,
    )
    await page.flusher.flush({ strict: true })
    assert.equal(rows(world, 'sessions').has(session.id), true)
    assert.equal(parent.calls.released, 0)
    page.flusher.releaseParent(session)
    page.flusher.releaseParent(session)
    assert.equal(parent.calls.released, 1)
    assert.equal(own.calls.released, 0)
    // The session's end releases its own lock only; the parent was let go already.
    beginIn(page, stateOf(goldenChart()))
    await page.flusher.flush({ strict: true })
    assert.equal(parent.calls.released, 1)
    assert.equal(own.calls.released, 1)
    // Nothing to release for a session that never held a parent.
    page.flusher.releaseParent(session)
    assert.equal(parent.calls.released, 1)
})

test('a fork takes the lease of its own lock as it registers, and releases it when it ends', async () => {
    const world = createWorld({ seed: 8 })
    const forks: FlushSession[] = []
    const made: { id: string; calls: { released: number }; lease: ReturnType<typeof leaseOf> }[] =
        []
    const first = await openPage(world, world.tab('a'), {
        onFork: (fork) => forks.push(fork),
        lockSession: (id) => {
            const each = counted()
            made.push({ id, ...each })
            return each.lease
        },
    })
    const a = stateOf(goldenChart())
    const session = beginIn(first, a)
    await first.flusher.flush()
    // B continues the chain meanwhile, so A's next flush forks.
    const second = await openPage(world, world.tab('b'))
    continueIn(second, await readOpen(second, session.id))
    second.flusher.append(
        { kind: 'edit', step: editStep(futureFixtureOperation('B')) },
        widen(a, 1),
        true,
    )
    await second.flusher.flush()
    first.flusher.append(
        { kind: 'edit', step: editStep(futureFixtureOperation('A')) },
        widen(a, 2),
        true,
    )
    await first.flusher.flush()
    assert.equal(forks.length, 1)
    const fork = forks[0]!
    const lock = made.find((each) => each.id === fork.id)
    assert.ok(lock)
    assert.equal(lock.lease.state, 'taken')
    assert.equal(lock.calls.released, 0)
    beginIn(first, stateOf(goldenChart()))
    await first.flusher.flush({ strict: true })
    assert.equal(lock.calls.released, 1)
    assert.equal(lock.lease.state, 'released')
})
