import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MemoryStorage } from '../../src/local/journal/store'
import { clientLock } from '../../src/local/locks'
import {
    findUnfinished,
    OpeningGuard,
    withOpening,
    type GuardEnv,
} from '../../src/local/startup/unfinished'
import type { LockSnapshot } from '../../src/platform/types'

const PREFIX = 'p.'
const keyOf = (page: string) => `${PREFIX}opening.${page}`
const recordOf = (storage: MemoryStorage, page: string) => {
    const text = storage.getItem(keyOf(page))
    return text === null ? undefined : (JSON.parse(text) as { ids: string[] }).ids
}

/** A page's environment, with each settle held until the test lets it run. */
const page = (storage: MemoryStorage, id = 'me') => {
    const settles: (() => void)[] = []
    const env: GuardEnv = {
        storage: () => storage,
        locks: { query: () => Promise.resolve({ held: [], pending: [] }) },
        clientLock: clientLock(id),
        granted: Promise.resolve(),
        prefix: PREFIX,
        settle: () =>
            new Promise<void>((resolve) => {
                settles.push(resolve)
            }),
    }
    return {
        env,
        settles,
        /** Lets the oldest waiting settle finish and the work after it run. */
        async release() {
            settles.shift()?.()
            await new Promise((resolve) => setTimeout(resolve, 0))
        },
    }
}

const locksHeld = (...pages: string[]) => ({
    query: (): Promise<LockSnapshot> =>
        Promise.resolve({
            held: pages.map((each) => ({
                name: clientLock(each),
                mode: 'exclusive' as const,
                clientId: each,
            })),
            pending: [],
        }),
})

test('a record is dead when its page lock is free, and live while it is held', async () => {
    const storage = new MemoryStorage()
    storage.setItem(keyOf('dead'), JSON.stringify({ ids: ['A'] }))
    storage.setItem(keyOf('live'), JSON.stringify({ ids: ['B'] }))
    storage.setItem(`${PREFIX}other`, '1')
    const found = await findUnfinished({
        storage: () => storage,
        locks: locksHeld('live'),
        prefix: PREFIX,
    })
    assert.deepEqual([...found.ids], ['A'])
    assert.deepEqual(found.keys, [keyOf('dead')])
})

test('with no records there is no lock query', async () => {
    const storage = new MemoryStorage()
    storage.setItem(`${PREFIX}other`, '1')
    let queries = 0
    const found = await findUnfinished({
        storage: () => storage,
        locks: {
            query: () => {
                queries++
                return Promise.resolve({ held: [], pending: [] })
            },
        },
        prefix: PREFIX,
    })
    assert.equal(found.ids.size, 0)
    assert.equal(queries, 0)
})

test('a record that is gone when read again is not dead', async () => {
    const storage = new MemoryStorage()
    storage.setItem(keyOf('gone'), JSON.stringify({ ids: ['A'] }))
    const found = await findUnfinished({
        storage: () => storage,
        locks: {
            query: () => {
                // The page removed its record while the query ran.
                storage.removeItem(keyOf('gone'))
                return Promise.resolve({ held: [], pending: [] })
            },
        },
        prefix: PREFIX,
    })
    assert.equal(found.ids.size, 0)
})

test('thrown storage and lock errors leave no guard and no failure', async () => {
    const broken = {
        get length(): number {
            throw new Error('no storage')
        },
        key: () => null,
        getItem: () => null,
        setItem: () => undefined,
        removeItem: () => undefined,
    }
    const none = await findUnfinished({
        storage: () => broken,
        locks: locksHeld(),
        prefix: PREFIX,
    })
    assert.equal(none.ids.size, 0)

    const storage = new MemoryStorage()
    storage.setItem(keyOf('dead'), JSON.stringify({ ids: ['A'] }))
    const failed = await findUnfinished({
        storage: () => storage,
        locks: { query: () => Promise.reject(new Error('no locks')) },
        prefix: PREFIX,
    })
    assert.equal(failed.ids.size, 0)

    // A write that throws does not reach the opening.
    const full = new MemoryStorage()
    full.quota = 0
    const opening = new OpeningGuard(page(full).env).begin()
    await opening.add('A')
    opening.end(false)
})

test('a published opening is retired only after the settle, and its record goes with it', async () => {
    const storage = new MemoryStorage()
    const world = page(storage)
    const opening = new OpeningGuard(world.env).begin()
    await opening.add('A')
    assert.deepEqual(recordOf(storage, 'me'), ['A'])
    opening.published()
    opening.end(false)
    assert.deepEqual(recordOf(storage, 'me'), ['A'])
    await world.release()
    assert.equal(recordOf(storage, 'me'), undefined)
})

test('nothing is retired while any opening is pending, and the settle waits for the last', async () => {
    const storage = new MemoryStorage()
    const world = page(storage)
    const guard = new OpeningGuard(world.env)
    const first = guard.begin()
    const second = guard.begin()
    await first.add('A')
    first.published()
    first.end(false)
    // The second opening has not ended: no settle has started.
    assert.equal(world.settles.length, 0)
    await second.add('B')
    second.end(false)
    assert.equal(world.settles.length, 1)
    await world.release()
    // The second never published: B stays.
    assert.deepEqual(recordOf(storage, 'me'), ['B'])
})

test('an opening begun during the settle stops it without retiring anything', async () => {
    const storage = new MemoryStorage()
    const world = page(storage)
    const guard = new OpeningGuard(world.env)
    const first = guard.begin()
    await first.add('A')
    first.published()
    first.end(false)
    const later = guard.begin()
    await world.release()
    assert.deepEqual(recordOf(storage, 'me'), ['A'])
    await later.add('B')
    later.published()
    later.end(false)
    await world.release()
    assert.equal(recordOf(storage, 'me'), undefined)
})

test('every exit ends an opening once, so pending returns to zero', async () => {
    const storage = new MemoryStorage()
    const world = page(storage)
    const guard = new OpeningGuard(world.env)
    const run = async (work: (opening: ReturnType<OpeningGuard['begin']>) => Promise<void>) => {
        const opening = guard.begin()
        await work(opening).catch(() => undefined)
        // A second end does nothing, even with a different outcome.
        opening.end(false)
        opening.end(true)
    }
    // A throw, a cancel or superseded request (no publish), an early return, and a publish.
    await run(async (opening) => {
        await opening.add('A')
        opening.end(true)
        throw new Error('threw')
    })
    await run(async (opening) => {
        await opening.add('B')
        opening.end(false)
    })
    await run(() => Promise.resolve())
    await run(async (opening) => {
        await opening.add('C')
        opening.published()
        opening.end(false)
    })
    // The settle for C started once every opening had ended.
    assert.equal(world.settles.length, 1)
    await world.release()
    // C is retired; A threw and B did not publish, so both stay.
    assert.deepEqual(recordOf(storage, 'me'), ['A', 'B'])
})

test('a throw keeps the ids of an opening that had published', async () => {
    const storage = new MemoryStorage()
    const world = page(storage)
    const opening = new OpeningGuard(world.env).begin()
    await opening.add('A')
    opening.published()
    opening.end(true)
    assert.equal(world.settles.length, 0)
    assert.deepEqual(recordOf(storage, 'me'), ['A'])
})

test('a return without publishing retires nothing', async () => {
    const storage = new MemoryStorage()
    const world = page(storage)
    const opening = new OpeningGuard(world.env).begin()
    await opening.add('A')
    opening.end(false)
    assert.equal(world.settles.length, 0)
    assert.deepEqual(recordOf(storage, 'me'), ['A'])
})

test('ids that threw stay when another session opens in the same page', async () => {
    const storage = new MemoryStorage()
    const world = page(storage)
    const guard = new OpeningGuard(world.env)
    const failed = guard.begin()
    await failed.add('A')
    failed.end(true)
    const good = guard.begin()
    await good.add('B')
    good.published()
    good.end(false)
    await world.release()
    assert.deepEqual(recordOf(storage, 'me'), ['A'])
})

test('two ids in one dead record: opening one retires only that one', async () => {
    const storage = new MemoryStorage()
    storage.setItem(keyOf('dead'), JSON.stringify({ ids: ['A', 'B'] }))
    const world = page(storage)
    const guard = new OpeningGuard(world.env, [keyOf('dead')])
    const openB = guard.begin()
    await openB.add('B')
    openB.published()
    openB.end(false)
    await world.release()
    assert.deepEqual(recordOf(storage, 'dead'), ['A'])
    const openA = guard.begin()
    await openA.add('A')
    openA.published()
    openA.end(false)
    await world.release()
    assert.equal(recordOf(storage, 'dead'), undefined)
})

test('withOpening passes a result and an error through', async () => {
    assert.equal(await withOpening(() => Promise.resolve(7)), 7)
    await assert.rejects(
        withOpening(() => Promise.reject(new Error('threw'))),
        /threw/,
    )
})

test('an id that published once and threw later stays, however the settles fall', async () => {
    const storage = new MemoryStorage()
    const world = page(storage)
    const guard = new OpeningGuard(world.env)
    const first = guard.begin()
    await first.add('A')
    first.published()
    first.end(false)
    const second = guard.begin()
    await second.add('A')
    second.end(true)
    await world.release()
    await world.release()
    assert.deepEqual(recordOf(storage, 'me'), ['A'])
})
