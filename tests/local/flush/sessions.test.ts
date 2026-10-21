import assert from 'node:assert/strict'
import test from 'node:test'
import { dateText, hostZone } from '../../../src/calendar/calendar'
import { countDayOfUse } from '../../../src/local/days'
import { readMeta } from '../../../src/local/db'
import { sessionLock } from '../../../src/local/locks'
import { holdParentLock, holdSessionLock, TabClient } from '../../../src/local/sessions'
import { createWorld } from '../../../src/local/testing/world'
import type { LockInfo, LockService } from '../../../src/platform/types'
import '../../helpers/lockChecks'
import { workerCore } from './harness'

// Session locks on the main thread, this tab's client id, parent locks for unstored
// continuations (§1.6.5, §1.6.6), and the days-of-use counter (§1.6.8.7).

test('a session lock is held until released; another tab can’t take it meanwhile', async () => {
    const world = createWorld({ seed: 1 })
    const a = world.tab('a')
    const b = world.tab('b')
    const held = await a.run(() => holdSessionLock(a.locks, 's1'))
    await a.run(() => held.granted)
    const tryTake = () =>
        b.run(() => b.locks.request(sessionLock('s1'), { ifAvailable: true }, async (got) => got))
    assert.equal(await tryTake(), false)
    held.release()
    await world.idle()
    assert.equal(await tryTake(), true)
})

test('a killed tab’s session lock is released, as Web Locks are', async () => {
    const world = createWorld({ seed: 2 })
    const a = world.tab('a')
    const b = world.tab('b')
    const held = await a.run(() => holdSessionLock(a.locks, 's1'))
    await a.run(() => held.granted)
    a.kill()
    await world.idle()
    const got = await b.run(() =>
        b.locks.request(sessionLock('s1'), { ifAvailable: true }, async (got) => got),
    )
    assert.equal(got, true)
})

test('a parent lock is shared: the parent counts as open, and can’t be taken exclusively', async () => {
    const world = createWorld({ seed: 3 })
    const a = world.tab('a')
    const b = world.tab('b')
    const parent = await a.run(() => holdParentLock(a.locks, 'parent'))
    await a.run(() => parent.granted)
    const other = await b.run(() => holdParentLock(b.locks, 'parent'))
    await b.run(() => other.granted)
    const exclusive = await b.run(() =>
        b.locks.request(sessionLock('parent'), { ifAvailable: true }, async (got) => got),
    )
    assert.equal(exclusive, false)
    parent.release()
    other.release()
    await world.idle()
})

test('this tab’s client id is read from its own nse-client lock', async () => {
    const world = createWorld({ seed: 4 })
    const a = world.tab('a')
    const b = world.tab('b')
    const client = await a.run(() => new TabClient(a.locks, 'r1'))
    assert.equal(await a.run(() => client.id()), 'a')
    const held = await b.run(() => holdSessionLock(b.locks, 's2'))
    await b.run(() => held.granted)
    assert.equal(await a.run(() => client.heldElsewhere(sessionLock('s2'))), true)
    const own = await a.run(() => holdSessionLock(a.locks, 's3'))
    await a.run(() => own.granted)
    assert.equal(await a.run(() => client.heldElsewhere(sessionLock('s3'))), false)
})

test('without client ids, a lock this tab holds still counts as held elsewhere', async () => {
    const world = createWorld({ seed: 6 })
    const a = world.tab('a')
    // An engine whose query() gives no clientId.
    const locks: LockService = {
        request: a.locks.request,
        query: async () => {
            const { held, pending } = await a.locks.query()
            const strip = ({ name, mode }: LockInfo) => ({ name, mode })
            return { held: held.map(strip), pending: pending.map(strip) }
        },
    }
    const client = await a.run(() => new TabClient(locks, 'r1'))
    const own = await a.run(() => holdSessionLock(locks, 's1'))
    await a.run(() => own.granted)
    assert.equal(await a.run(() => client.heldElsewhere(sessionLock('s1'))), true)
    assert.equal(await a.run(() => client.heldElsewhere(sessionLock('s2'))), false)
})

test('days of use go up once per calendar day, and never for a clock set back', async () => {
    const world = createWorld({ seed: 5 })
    const tab = world.tab('a')
    const core = workerCore(world, tab)
    await tab.run(() => core.start())
    const day = (time: number) =>
        tab.run(() => core.write(['meta'], (tx) => countDayOfUse(tx, time)))
    const noon = new Date(2026, 9, 17, 12).getTime()
    assert.equal(await day(noon), 1)
    assert.equal(await day(noon + 3_600_000), 1)
    assert.equal(await day(noon + 86_400_000), 2)
    // A clock set back a week counts nothing until it passes the last day again.
    assert.equal(await day(noon - 7 * 86_400_000), 2)
    // A clock jumped forward a year adds one day, not 365.
    assert.equal(await day(noon + 365 * 86_400_000), 3)
    const last = await tab.run(() => core.read(['meta'], (tx) => readMeta(tx, 'lastUseDate')))
    assert.equal(last, dateText(noon + 365 * 86_400_000, hostZone()))
})
