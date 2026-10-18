import assert from 'node:assert/strict'
import test from 'node:test'
import { sha256Hex } from '../../../src/preview/assets/files/importer'
import { createMemoryStore, type UserAssetRecord } from '../../../src/preview/assets/files/store'
import { StoreFailed, storeRecords } from '../../../src/preview/assets/files/storeRecords'

const deferred = () => {
    let resolve!: () => void
    const promise = new Promise<void>((done) => (resolve = done))
    return { promise, resolve }
}

const recordOf = async (): Promise<UserAssetRecord> => {
    const bytes = new Blob(['checked package'])
    return {
        key: await sha256Hex(bytes),
        type: 'skin',
        name: 'fixture',
        title: 'Fixture',
        author: 'Author',
        origin: 'fixture.scp',
        size: bytes.size,
        addedAt: 1,
        lastUsedAt: 1,
        bytes,
    }
}

test('successful storage returns the put result after checking size and SHA-256', async () => {
    const record = await recordOf()
    const memory = createMemoryStore()
    const result = await memory.putMany([record])
    const stored = await storeRecords({ ...memory, putMany: async () => result }, [record])
    assert.equal(stored, result)
    assert.deepEqual(stored.added, [record.key])
})

for (const failure of ['size', 'hash', 'missing', 'unreadable'] as const)
    test(`a delayed ${failure} readback failure cannot delete a later verified write`, async (t) => {
        const record = await recordOf()
        const memory = createMemoryStore()
        const reading = deferred()
        const release = deferred()
        const remove = t.mock.fn(memory.remove)
        const first = storeRecords(
            {
                ...memory,
                remove,
                get: async (key) => {
                    const captured = await memory.get(key)
                    assert.ok(captured)
                    const back =
                        failure === 'missing'
                            ? undefined
                            : {
                                  ...captured,
                                  bytes:
                                      failure === 'size'
                                          ? captured.bytes.slice(0, 1)
                                          : new Blob([new Uint8Array(captured.size)]),
                              }
                    reading.resolve()
                    await release.promise
                    if (failure === 'unreadable') throw new Error('Read failed')
                    return back
                },
            },
            [record],
        )
        await reading.promise
        const later = { ...record, origin: 'later.scp', lastUsedAt: 2 }
        await storeRecords({ ...memory, remove }, [later])
        release.resolve()
        await assert.rejects(first, StoreFailed)
        const current = await memory.get(record.key)
        assert.equal(current?.origin, 'later.scp')
        assert.equal(current?.lastUsedAt, 2)
        assert.ok(current)
        assert.equal(await sha256Hex(current.bytes), record.key)
        assert.equal(remove.mock.callCount(), 0)
    })

test('an atomic write failure remains StoreFailed without reading back or removing', async (t) => {
    const memory = createMemoryStore()
    const get = t.mock.fn(memory.get)
    const remove = t.mock.fn(memory.remove)
    await assert.rejects(
        storeRecords(
            {
                ...memory,
                get,
                remove,
                putMany: () =>
                    Promise.reject(new DOMException('Quota exceeded', 'QuotaExceededError')),
            },
            [await recordOf()],
        ),
        StoreFailed,
    )
    assert.deepEqual(await memory.list(), [])
    assert.equal(get.mock.callCount(), 0)
    assert.equal(remove.mock.callCount(), 0)
})
