import assert from 'node:assert/strict'
import test from 'node:test'
import { STORES_V1 } from '../../src/local/db'
import {
    decodeValue,
    dumpDatabase,
    DumpError,
    dumpLocalStorage,
    encodeValue,
    readDump,
    toBase64,
    type Dump,
} from '../../src/local/dump'
import type { KvDatabase } from '../../src/local/kv/types'
import { seedDump } from '../../src/local/seed'
import { openLocalData } from '../../src/local/testing/db'
import { createWorld, type Tab } from '../../src/local/testing/world'

// The dump format (Part 1 §1.6.11.9) and the dev-only sample seeder.

const b64 = (bytes: number[]) => toBase64(new Uint8Array(bytes))

const hash = (n: number) => ({ $ab: b64(Array.from({ length: 16 }, (_, i) => (i + n) % 256)) })

/** A small v1 dump with every tag, in key order. */
const sampleDump = (): Dump => ({
    format: 'nse-local-data-dump',
    version: 1,
    appVersion: '0.6.0',
    database: { name: 'nse-local-data', version: 1 },
    stores: Object.entries(STORES_V1)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([name, spec]) => ({
            name,
            keyPath: spec.keyPath === null ? null : (spec.keyPath as string | string[]),
            autoIncrement: false,
            indexes: Object.entries(spec.indexes)
                .sort(([a], [b]) => (a < b ? -1 : 1))
                .map(([index, keyPath]) => ({
                    name: index,
                    keyPath,
                    unique: false,
                    multiEntry: false,
                })),
            records:
                name === 'chains'
                    ? [
                          {
                              key: 'c1',
                              value: {
                                  chainId: 'c1',
                                  head: 's1',
                                  updatedAt: 5,
                                  docId: 'd1',
                                  file: {
                                      hash: { $u8: b64([1, 2, 3]) },
                                      handle: { $handle: 'file', name: 'a.nxsp' },
                                  },
                                  $$dollar: 'kept',
                                  gone: { $undefined: true },
                              },
                          },
                      ]
                    : name === 'sessions'
                      ? [{ key: 's1', value: { id: 's1', chainId: 'c1', updatedAt: 5 } }]
                      : name === 'entries'
                        ? [1, 2].map((seq) => ({
                              key: ['s1', seq],
                              value: { sessionId: 's1', seq, kind: 'edit', time: seq * 1000 },
                          }))
                        : name === 'nodes'
                          ? [1, 2].map((n) => ({ key: hash(n), value: { $u8: b64([n, n]) } }))
                          : name === 'media'
                            ? [
                                  {
                                      key: hash(3),
                                      value: {
                                          blob: { $blob: b64([9, 8, 7]), type: 'audio/mpeg' },
                                      },
                                  },
                              ]
                            : name === 'meta'
                              ? [
                                    {
                                        key: 'dbInstanceId',
                                        value: { key: 'dbInstanceId', value: 'db-x' },
                                    },
                                    { key: 'deviceId', value: { key: 'deviceId', value: 'dev-x' } },
                                ]
                              : [],
        })),
    localStorage: {
        'sonolus-next-sekai-editor.canary': '"db-x"',
        'sonolus-next-sekai-editor.deviceId': '"dev-x"',
    },
})

const fakeStorage = () => {
    const items = new Map<string, string>()
    return {
        items,
        setItem: (key: string, value: string) => {
            items.set(key, value)
        },
    }
}

const dumpOf = (tab: Tab, db: KvDatabase) =>
    tab.run(() => dumpDatabase(db, { appVersion: '0.6.0', localStorage: {} }))

/** The dump without the handle, which the seeder leaves out. */
const withoutHandle = (dump: Dump) => {
    const copy = structuredClone(dump)
    const chain = copy.stores.find((store) => store.name === 'chains')!.records[0]!
    delete (chain.value as { file: Record<string, unknown> }).file.handle
    copy.localStorage = {}
    return copy
}

test('a seeded dump reads back equal', async () => {
    const world = createWorld()
    const tab = world.tab('a')
    const storage = fakeStorage()
    const dump = sampleDump()
    assert.deepEqual(await tab.run(() => seedDump(tab.kv, readDump(dump), storage)), {
        seeded: true,
    })
    assert.deepEqual(Object.fromEntries(storage.items), dump.localStorage)
    const db = await tab.kv.open('nse-local-data', undefined)
    assert.deepEqual(await dumpOf(tab, db), withoutHandle(dump))
    // The values as stored: a Uint8Array stays one, the hash key an ArrayBuffer, the Blob a Blob.
    const chain = (await tab.run(() =>
        db.transaction(['chains'], 'readonly', (tx) => tx.get('chains', 'c1')),
    )) as Record<string, unknown>
    assert.ok((chain.file as { hash: unknown }).hash instanceof Uint8Array)
    assert.equal(chain.$dollar, 'kept')
    assert.ok('gone' in chain && chain.gone === undefined)
    await world.idle()
})

test('the seeder refuses a database with chains or sessions, and changes nothing', async () => {
    for (const store of ['chains', 'sessions'] as const) {
        const world = createWorld()
        const tab = world.tab('a')
        const db = await openLocalData(tab)
        const row =
            store === 'chains'
                ? { chainId: 'mine', head: 'x', updatedAt: 1 }
                : { id: 'mine', chainId: 'x', updatedAt: 1 }
        await tab.run(() => db.transaction([store], 'readwrite', (tx) => tx.put(store, row)))
        const before = await dumpOf(tab, db)
        db.close()
        const storage = fakeStorage()
        const result = await tab.run(() => seedDump(tab.kv, sampleDump(), storage))
        assert.equal(result.seeded, false)
        assert.equal(storage.items.size, 0)
        const again = await tab.kv.open('nse-local-data', undefined)
        assert.deepEqual(await dumpOf(tab, again), before)
        await world.idle()
    }
})

test('into an empty database the build made, meta is the dump’s as one set', async () => {
    const world = createWorld()
    const tab = world.tab('a')
    const db = await openLocalData(tab)
    db.close()
    const storage = fakeStorage()
    assert.deepEqual(await tab.run(() => seedDump(tab.kv, sampleDump(), storage)), {
        seeded: true,
    })
    const again = await tab.kv.open('nse-local-data', undefined)
    const meta = await tab.run(() =>
        again.transaction(['meta'], 'readonly', async (tx) => ({
            db: await tx.get('meta', 'dbInstanceId'),
            device: await tx.get('meta', 'deviceId'),
        })),
    )
    assert.deepEqual(meta, {
        db: { key: 'dbInstanceId', value: 'db-x' },
        device: { key: 'deviceId', value: 'dev-x' },
    })
    assert.equal(storage.items.get('sonolus-next-sekai-editor.canary'), '"db-x"')
    await world.idle()
})

test('the seeder refuses a database newer than the dump', async () => {
    const world = createWorld()
    const tab = world.tab('a')
    ;(await openLocalData(tab, 2)).close()
    const result = await tab.run(() => seedDump(tab.kv, sampleDump(), fakeStorage()))
    assert.equal(result.seeded, false)
    await world.idle()
})

test('the dumper writes a view’s own bytes and throws on what it has no tag for', () => {
    const buffer = new Uint8Array([0, 1, 2, 3, 4, 5]).buffer
    assert.deepEqual(encodeValue(new Uint8Array(buffer, 2, 2), new Map()), { $u8: b64([2, 3]) })
    assert.deepEqual(encodeValue(buffer, new Map()), { $ab: b64([0, 1, 2, 3, 4, 5]) })
    assert.deepEqual(encodeValue({ $a: [undefined] }, new Map()), {
        $$a: [{ $undefined: true }],
    })
    for (const value of [new Date(0), new Map(), 1n, NaN, Infinity, new Uint16Array(1)])
        assert.throws(() => encodeValue({ value }, new Map()), DumpError)
})

test('the reader checks tags, base64, key order and in-line keys', () => {
    assert.throws(() => decodeValue({ $ab: 'AQ' }), /padded/)
    assert.throws(() => decodeValue({ $new: 1 }), /unknown tag/)
    assert.deepEqual(decodeValue({ $$x: { $undefined: true } }), { $x: undefined })
    const swap = sampleDump()
    swap.stores.find((store) => store.name === 'entries')!.records.reverse()
    assert.throws(() => readDump(swap), /out of key order/)
    const wrong = sampleDump()
    wrong.stores.find((store) => store.name === 'sessions')!.records[0]!.key = 's2'
    assert.throws(() => readDump(wrong), /its key is not the one in its value/)
    assert.throws(() => readDump({ ...sampleDump(), version: 2 }), /newer/)
    assert.throws(() => readDump({ ...sampleDump(), format: 'other' }), DumpError)
    readDump(JSON.parse(JSON.stringify(sampleDump())))
})

test('localStorage: only the editor’s keys, in order', () => {
    const items: Record<string, string> = {
        'sonolus-next-sekai-editor.b': '2',
        'nse.test.storage': '{}',
        'sonolus-next-sekai-editor.a': '1',
    }
    const keys = Object.keys(items)
    const storage = {
        get length() {
            return keys.length
        },
        key: (i: number) => keys[i] ?? null,
        getItem: (key: string) => items[key] ?? null,
    } as Storage
    assert.deepEqual(Object.entries(dumpLocalStorage(storage, 'sonolus-next-sekai-editor.')), [
        ['sonolus-next-sekai-editor.a', '1'],
        ['sonolus-next-sekai-editor.b', '2'],
    ])
})
