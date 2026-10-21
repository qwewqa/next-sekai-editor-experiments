import assert from 'node:assert/strict'
import test from 'node:test'
import type { CommitReport } from '../../../src/local/kv/memory'
import type { Durability, KvDatabase, KvUpgrade } from '../../../src/local/kv/types'
import { createWorld, type Tab } from '../../../src/local/testing/world'

// The memory store's test hooks (design A §7, R2-5 and R3-6): the durability each transaction asked
// for, the commit hook, and the two power losses. `loseRelaxed(k)` models Chromium and Firefox 126
// and later, which honour `strict`; `loseCommits(n)` Firefox before 126, which does not. Both keep
// commit order: a lost commit loses every later one.

const schema = (upgrade: KvUpgrade) => {
    if (upgrade.oldVersion < 1) upgrade.createStore('rows', { keyPath: 'id' })
}

const open = (tab: Tab) => tab.kv.open('db', 1, { upgrade: schema })

/** One commit putting `id`, with the durability given (none: the browser's default). */
const put = (tab: Tab, db: KvDatabase, id: string, durability?: Durability) =>
    tab.run(() =>
        db.transaction(
            ['rows'],
            'readwrite',
            async (tx) => {
                await tx.put('rows', { id })
            },
            durability === undefined ? undefined : { durability },
        ),
    )

const ids = async (tab: Tab, db: KvDatabase) =>
    (
        (await tab.run(() => db.transaction(['rows'], 'readonly', (tx) => tx.getAll('rows')))) as {
            id: string
        }[]
    ).map((row) => row.id)

const setup = async (commitLog = true) => {
    const world = createWorld({ seed: 7, commitLog })
    const tab = world.tab('a')
    const db = await open(tab)
    return { world, tab, db }
}

test('the commit hook reports each committed read-write transaction with its durability', async () => {
    const { world, tab, db } = await setup(false)
    const seen: CommitReport[] = []
    world.memory.observe({ committed: (report) => seen.push(report) })
    await put(tab, db, 'a', 'strict')
    await put(tab, db, 'b', 'relaxed')
    // A write given no durability counts as the browser's default, which is relaxed.
    await put(tab, db, 'c')
    await tab.run(() => db.transaction(['rows'], 'readonly', (tx) => tx.getAll('rows')))
    await assert.rejects(
        tab.run(() =>
            db.transaction(['rows'], 'readwrite', async (tx) => {
                await tx.put('rows', { id: 'gone' })
                throw new Error('no')
            }),
        ),
    )
    assert.deepEqual(
        seen.map((report) => [report.durability, report.puts.map((row) => row.key)]),
        [
            ['strict', ['a']],
            ['relaxed', ['b']],
            ['default', ['c']],
        ],
    )
    assert.equal(seen[0]!.current('rows', 'a') !== undefined, true)
    assert.equal(seen[0]!.puts[0]!.old, undefined)
})

test('a put over a row reports the value it replaced, and a delete the rows it removed', async () => {
    const { world, tab, db } = await setup(false)
    await put(tab, db, 'a')
    const seen: CommitReport[] = []
    world.memory.observe({ committed: (report) => seen.push(report) })
    await tab.run(() =>
        db.transaction(['rows'], 'readwrite', async (tx) => {
            await tx.put('rows', { id: 'a', v: 2 })
            await tx.put('rows', { id: 'a', v: 3 })
            await tx.put('rows', { id: 'b' })
        }),
    )
    assert.deepEqual(
        seen[0]!.puts.map((row) => [row.key, row.old, row.value]),
        [
            ['a', { id: 'a' }, { id: 'a', v: 3 }],
            ['b', undefined, { id: 'b' }],
        ],
    )
    await tab.run(() => db.transaction(['rows'], 'readwrite', (tx) => tx.delete('rows', 'a')))
    assert.deepEqual(
        seen[1]!.deletes.map((each) => each.rows.map((row) => row.key)),
        [['a']],
    )
})

test('created reports the creating actor and the durability asked for, for read-write only', async () => {
    const { world, tab, db } = await setup(false)
    const created: [string, Durability][] = []
    world.memory.observe({
        created: ({ actor, durability }) => {
            created.push([actor.name, durability])
            return actor.name
        },
        committed: (report) => created.push([String(report.context), report.durability]),
    })
    await put(tab, db, 'a', 'strict')
    await tab.run(() => db.transaction(['rows'], 'readonly', (tx) => tx.getAll('rows')))
    assert.deepEqual(created, [
        ['a', 'strict'],
        ['a', 'strict'],
    ])
})

test('loseRelaxed undoes the last relaxed commits since the last strict one, newest first', async () => {
    const { world, tab, db } = await setup()
    await put(tab, db, 'a', 'strict')
    await put(tab, db, 'b', 'relaxed')
    await put(tab, db, 'c')
    await put(tab, db, 'd', 'relaxed')
    assert.equal(world.memory.relaxedCommits, 3)
    tab.kill()
    assert.equal(world.memory.loseRelaxed(2), 2)
    const next = world.tab('b')
    assert.deepEqual(await ids(next, await open(next)), ['a', 'b'])
    // A power loss keeps commit order: nothing is undone out of turn.
    assert.equal(world.memory.relaxedCommits, 1)
})

test('loseRelaxed never undoes a strict commit or what it made durable', async () => {
    const { world, tab, db } = await setup()
    await put(tab, db, 'a', 'relaxed')
    await put(tab, db, 'b', 'strict')
    await put(tab, db, 'c', 'relaxed')
    tab.kill()
    assert.equal(world.memory.relaxedCommits, 1)
    assert.throws(() => world.memory.loseRelaxed(2), /Only 1 relaxed commits/)
    world.memory.loseRelaxed(1)
    const next = world.tab('b')
    assert.deepEqual(await ids(next, await open(next)), ['a', 'b'])
})

test('a strict commit with no writes still makes the earlier relaxed ones durable', async () => {
    const { world, tab, db } = await setup()
    await put(tab, db, 'a', 'relaxed')
    await tab.run(() =>
        db.transaction(['rows'], 'readwrite', async () => undefined, { durability: 'strict' }),
    )
    assert.equal(world.memory.relaxedCommits, 0)
    tab.kill()
    assert.throws(() => world.memory.loseRelaxed(1), /Only 0 relaxed/)
})

test('loseCommits undoes the last commits whatever their durability, in commit order', async () => {
    const { world, tab, db } = await setup()
    await put(tab, db, 'a', 'strict')
    await put(tab, db, 'b', 'strict')
    await put(tab, db, 'c', 'relaxed')
    tab.kill()
    assert.equal(world.memory.loseCommits(2), 2)
    const next = world.tab('b')
    assert.deepEqual(await ids(next, await open(next)), ['a'])
    assert.throws(() => world.memory.loseCommits(2), /Only 1 commits/)
})

test('a commit over rows it replaced and deleted is undone to the rows it found', async () => {
    const { world, tab, db } = await setup()
    await put(tab, db, 'a', 'strict')
    await tab.run(() =>
        db.transaction(
            ['rows'],
            'readwrite',
            async (tx) => {
                await tx.put('rows', { id: 'a', v: 2 })
                await tx.put('rows', { id: 'b' })
                await tx.delete('rows', 'a')
            },
            { durability: 'relaxed' },
        ),
    )
    tab.kill()
    world.memory.loseRelaxed(1)
    const next = world.tab('b')
    const rows = (await next.run(async () => {
        const again = await open(next)
        return again.transaction(['rows'], 'readonly', (tx) => tx.getAll('rows'))
    })) as unknown[]
    assert.deepEqual(rows, [{ id: 'a' }])
})

test('a power loss with a transaction in flight, or no commit log, is refused', async () => {
    const off = await setup(false)
    await put(off.tab, off.db, 'a')
    off.tab.kill()
    assert.throws(() => off.world.memory.loseCommits(1), /recordCommits|Only 0/)
    const { world, tab, db } = await setup()
    await put(tab, db, 'a')
    // Not killed: a tab's transaction would be in flight in a real power loss only if it were
    // still running, so start one and lose before it ends.
    let lost: unknown
    await tab.run(() =>
        db.transaction(['rows'], 'readwrite', async (tx) => {
            await tx.put('rows', { id: 'b' })
            try {
                world.memory.loseCommits(1)
            } catch (error) {
                lost = error
            }
        }),
    )
    assert.match(String((lost as Error).message), /Kill every tab/)
})
