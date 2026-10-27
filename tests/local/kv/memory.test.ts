import assert from 'node:assert/strict'
import test from 'node:test'
import { compareKeys } from '../../../src/local/kv/keys'
import { KeyRange, type KvDatabase, type KvUpgrade } from '../../../src/local/kv/types'
import { createWorld, type Tab } from '../../../src/local/testing/world'

// The in-memory key-value store against IndexedDB's rules.

const schema = (upgrade: KvUpgrade) => {
    if (upgrade.oldVersion < 1) {
        upgrade.createStore('rows', { keyPath: 'id' })
        upgrade.createIndex('rows', 'by', 'by')
        upgrade.createStore('blobs', {})
        upgrade.createStore('pairs', { keyPath: ['a', 'b'] })
    }
}

const open = (tab: Tab, version: number | 'none' = 1, blocked?: () => void) =>
    tab.kv.open('db', version === 'none' ? undefined : version, { upgrade: schema, blocked })

const write = (tab: Tab, db: KvDatabase, fn: Parameters<KvDatabase['transaction']>[2]) =>
    tab.run(() => db.transaction(['rows', 'blobs', 'pairs'], 'readwrite', fn))

test('keys order as IndexedDB orders them, binary keys by bytes', () => {
    const keys = [
        [1, 'a'],
        new Uint8Array([2]).buffer,
        new Uint8Array([1, 255]).buffer,
        'b',
        'a',
        new Date(5),
        3,
        -1,
        [1],
    ]
    const sorted = [...keys].sort(compareKeys)
    assert.deepEqual(
        sorted.map((key) =>
            key instanceof ArrayBuffer ? [...new Uint8Array(key)].join('.') : key,
        ),
        [-1, 3, new Date(5), 'a', 'b', '1.255', '2', [1], [1, 'a']],
    )
})

test('put, get, ranges, indexes and cursors', async () => {
    const world = createWorld()
    const tab = world.tab('a')
    const db = await open(tab)
    await write(tab, db, async (tx) => {
        for (const [id, by] of [
            ['x', 3],
            ['y', 1],
            ['z', 2],
        ] as const)
            await tx.put('rows', { id, by })
        await tx.put('blobs', { bytes: new Uint8Array([1, 2]) }, new Uint8Array([9, 9]))
        await tx.put('pairs', { a: 's', b: 2 })
        await tx.put('pairs', { a: 's', b: 1 })
    })
    const read = await tab.run(() =>
        db.transaction(['rows', 'blobs', 'pairs'], 'readonly', async (tx) => ({
            row: await tx.get('rows', 'y'),
            range: await tx.getAllKeys('rows', KeyRange.bound('x', 'y')),
            byIndex: (await tx.index('rows', 'by').getAll()).map(
                (row) => (row as { id: string }).id,
            ),
            newest: (await tx.entries('rows', { index: 'by', direction: 'prev', limit: 2 })).map(
                (entry) => entry.primaryKey,
            ),
            blob: await tx.get('blobs', new Uint8Array([9, 9]).buffer),
            pairs: await tx.getAllKeys('pairs', KeyRange.bound(['s'], ['s', []])),
            count: await tx.count('rows'),
            describe: tx.describe('rows'),
        })),
    )
    assert.deepEqual(read.row, { id: 'y', by: 1 })
    assert.deepEqual(read.range, ['x', 'y'])
    assert.deepEqual(read.byIndex, ['y', 'z', 'x'])
    assert.deepEqual(read.newest, ['x', 'z'])
    assert.deepEqual(read.blob, { bytes: new Uint8Array([1, 2]) })
    assert.deepEqual(read.pairs, [
        ['s', 1],
        ['s', 2],
    ])
    assert.equal(read.count, 3)
    assert.deepEqual(read.describe, { keyPath: 'id', indexes: { by: 'by' } })
    await world.idle()
})

test('values are cloned on write and on read', async () => {
    const world = createWorld()
    const tab = world.tab('a')
    const db = await open(tab)
    const value = { id: 'a', list: [1] }
    await write(tab, db, async (tx) => {
        const put = tx.put('rows', value)
        value.list.push(2)
        await put
    })
    const row = await tab.run(() =>
        db.transaction(['rows'], 'readonly', async (tx) => {
            const first = (await tx.get('rows', 'a')) as typeof value
            first.list.push(3)
            return tx.get('rows', 'a')
        }),
    )
    assert.deepEqual(row, { id: 'a', list: [1] })
})

test('a throw in the function aborts and leaves nothing written', async () => {
    const world = createWorld()
    const tab = world.tab('a')
    const db = await open(tab)
    await assert.rejects(
        write(tab, db, async (tx) => {
            await tx.put('rows', { id: 'a' })
            throw new Error('no')
        }),
        /no/,
    )
    await assert.rejects(
        write(tab, db, async (tx) => {
            await tx.put('rows', { id: 'b' })
            await tx.add('rows', { id: 'b' })
        }),
        { name: 'ConstraintError' },
    )
    const count = await tab.run(() =>
        db.transaction(['rows'], 'readonly', (tx) => tx.count('rows')),
    )
    assert.equal(count, 0)
    await assert.rejects(
        tab.run(() => db.transaction(['rows'], 'readonly', (tx) => tx.put('rows', { id: 'c' }))),
        { name: 'ReadOnlyError' },
    )
    await assert.rejects(
        write(tab, db, (tx) => tx.put('rows', { other: 1 })),
        { name: 'DataError' },
    )
})

test('a transaction created outside a task is refused under a seed', async () => {
    const world = createWorld({ seed: 1 })
    const tab = world.tab('a')
    const db = await open(tab)
    // Code after an outside await runs in no task.
    await new Promise((resolve) => setTimeout(resolve, 1))
    await assert.rejects(
        db.transaction(['rows'], 'readonly', (tx) => tx.count('rows')),
        /inside a scheduler task/,
    )
})

test('versions: an older open is a VersionError, a newer one upgrades once others close', async () => {
    const world = createWorld()
    const a = world.tab('a')
    const b = world.tab('b')
    const first = await open(a, 2)
    assert.equal(first.version, 2)
    await assert.rejects(open(b, 1), { name: 'VersionError' })
    const versionless = await open(b, 'none')
    assert.equal(versionless.version, 2)

    const asked: (number | null)[] = []
    first.onversionchange = (version) => {
        asked.push(version)
    }
    versionless.onversionchange = (version) => {
        asked.push(version)
        versionless.close()
    }
    let blocked = 0
    const upgrading = open(world.tab('c'), 3, () => blocked++)
    await world.scheduler.idle()
    assert.deepEqual(asked, [3, 3])
    assert.equal(blocked, 1)
    // The queue holds every later open behind the blocked upgrade.
    let queued = false
    void open(world.tab('d'), 'none').then(() => (queued = true))
    await world.scheduler.idle()
    assert.equal(queued, false)
    first.close()
    const upgraded = await upgrading
    assert.equal(upgraded.version, 3)
    await world.scheduler.idle()
    assert.equal(queued, true)
    await assert.rejects(
        a.run(() => first.transaction(['rows'], 'readonly', (tx) => tx.count('rows'))),
        { name: 'InvalidStateError' },
    )
})

test("a killed tab's connection closes, so a blocked upgrade goes ahead", async () => {
    const world = createWorld()
    const frozen = world.tab('frozen')
    await open(frozen, 1)
    let blocked = false
    const upgrading = open(world.tab('new'), 2, () => (blocked = true))
    await world.scheduler.idle()
    assert.equal(blocked, true)
    frozen.kill()
    assert.equal((await upgrading).version, 2)
})

test('a lost connection aborts its transaction with UnknownError and fires onclose', async () => {
    const world = createWorld()
    const tab = world.tab('a')
    const db = await open(tab)
    let closed = false
    db.onclose = () => (closed = true)
    const lost = write(tab, db, async (tx) => {
        await tx.put('rows', { id: 'a' })
        world.memory.loseConnections('db')
        await tx.put('rows', { id: 'b' })
    })
    await assert.rejects(lost)
    await world.idle()
    assert.equal(closed, true)
    const again = await open(tab)
    const count = await tab.run(() =>
        again.transaction(['rows'], 'readonly', (tx) => tx.count('rows')),
    )
    assert.equal(count, 0)
})
