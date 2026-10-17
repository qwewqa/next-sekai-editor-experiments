import assert from 'node:assert/strict'
import test from 'node:test'
import { openLocalData } from '../../src/local/testing/db'
import { createWorld } from '../../src/local/testing/world'
import {
    getUserAsset,
    listUserAssets,
    putUserAsset,
    removeUserAsset,
    touchUserAsset,
    USER_ASSETS,
    type UserAssetRecord,
} from '../../src/local/userAssets'

// The stored preview packages (Part 1 §1.5.8): put, list without bytes, get with bytes, touch, remove.

const record = (key: string, overrides: Partial<UserAssetRecord> = {}): UserAssetRecord => ({
    key,
    type: 'skin',
    name: 'item',
    title: `Title ${key}`,
    author: 'Author',
    origin: 'item.scp',
    bytes: new Blob([`bytes of ${key}`]),
    size: 12,
    addedAt: 100,
    lastUsedAt: 100,
    ...overrides,
})

const setup = async () => {
    const world = createWorld({ seed: 1 })
    const tab = world.tab('a')
    const db = await openLocalData(tab)
    const run = <T>(mode: 'readonly' | 'readwrite', fn: Parameters<typeof db.transaction<T>>[2]) =>
        tab.run(() => db.transaction([USER_ASSETS], mode, fn))
    return { world, run }
}

test('a stored package lists without its bytes, newest first, and reads back whole', async () => {
    const { world, run } = await setup()
    await run('readwrite', (tx) => putUserAsset(tx, record('a', { addedAt: 100 })))
    await run('readwrite', (tx) => putUserAsset(tx, record('b', { addedAt: 300, type: 'effect' })))
    await run('readwrite', (tx) => putUserAsset(tx, record('c', { addedAt: 200 })))

    const list = await run('readonly', listUserAssets)
    assert.deepEqual(
        list.map((item) => item.key),
        ['b', 'c', 'a'],
    )
    assert.ok(list.every((item) => !('bytes' in item)))
    assert.equal(list[0]?.type, 'effect')

    const whole = await run('readonly', (tx) => getUserAsset(tx, 'a'))
    assert.equal(whole?.title, 'Title a')
    assert.ok(whole?.bytes instanceof Blob)
    assert.equal(await run('readonly', (tx) => getUserAsset(tx, 'nothing')), undefined)
    await world.idle()
})

test('putting a package again keeps when it was added, and the type index finds a type', async () => {
    const { world, run } = await setup()
    await run('readwrite', (tx) => putUserAsset(tx, record('a', { addedAt: 100 })))
    const again = await run('readwrite', (tx) =>
        putUserAsset(tx, record('a', { addedAt: 900, lastUsedAt: 900 })),
    )
    assert.equal(again.addedAt, 100)
    assert.equal(again.lastUsedAt, 900)
    assert.equal((await run('readonly', listUserAssets)).length, 1)

    await run('readwrite', (tx) => putUserAsset(tx, record('b', { type: 'particle' })))
    const particles = await run('readonly', (tx) =>
        tx.index(USER_ASSETS, 'type').getAll('particle'),
    )
    assert.equal(particles.length, 1)
    await world.idle()
})

test('touch marks a package used; remove deletes it', async () => {
    const { world, run } = await setup()
    await run('readwrite', (tx) => putUserAsset(tx, record('a')))
    assert.equal(await run('readwrite', (tx) => touchUserAsset(tx, 'a', 555)), true)
    assert.equal((await run('readonly', (tx) => getUserAsset(tx, 'a')))?.lastUsedAt, 555)
    assert.equal(await run('readwrite', (tx) => touchUserAsset(tx, 'nothing', 555)), false)

    await run('readwrite', (tx) => removeUserAsset(tx, 'a'))
    assert.deepEqual(await run('readonly', listUserAssets), [])
    // Removing what is not there is not an error.
    await run('readwrite', (tx) => removeUserAsset(tx, 'a'))
    await world.idle()
})
