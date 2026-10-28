import assert from 'node:assert/strict'
import test from 'node:test'
import { DB_VERSION, STORES_V1 } from '../../src/local/db'
import {
    decodeValue,
    dumpDatabase,
    DumpError,
    dumpJsonBytes,
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

// The dump format and the dev-only sample seeder.

const b64 = (bytes: number[]) => toBase64(new Uint8Array(bytes))

const noBlob = (): never => assert.fail('No Blob here')

const hash = (n: number) => ({ $ab: b64(Array.from({ length: 16 }, (_, i) => (i + n) % 256)) })

/** A small v1 dump with every tag, in key order. */
const sampleDump = (): Dump => ({
    format: 'nse-local-data-dump',
    version: 1,
    appVersion: '0.6.0',
    database: { name: 'nse-local-data', version: DB_VERSION },
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
                        : name === 'handles'
                          ? [
                                {
                                    key: ['c1', 'file'],
                                    value: {
                                        chainId: 'c1',
                                        role: 'file',
                                        name: 'a.nxsp',
                                        handle: { $handle: 'file', name: 'a.nxsp' },
                                    },
                                },
                            ]
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
                                      {
                                          key: 'deviceId',
                                          value: { key: 'deviceId', value: 'dev-x' },
                                      },
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

/** The dump without the handles, which the seeder leaves out: a `handles` row goes whole. */
const withoutHandle = (dump: Dump) => {
    const copy = structuredClone(dump)
    const chain = copy.stores.find((store) => store.name === 'chains')!.records[0]!
    delete (chain.value as { file: Record<string, unknown> }).file.handle
    copy.stores.find((store) => store.name === 'handles')!.records = []
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

test("a sample's agreement record is not seeded: the profile agrees for itself", async () => {
    const world = createWorld()
    const tab = world.tab('a')
    const storage = fakeStorage()
    const dump = sampleDump()
    const agreement = 'sonolus-next-sekai-editor.agreement'
    const seeded = { ...dump, localStorage: { ...dump.localStorage, [agreement]: '{"terms":999}' } }
    assert.deepEqual(await tab.run(() => seedDump(tab.kv, readDump(seeded), storage)), {
        seeded: true,
    })
    assert.deepEqual(Object.fromEntries(storage.items), dump.localStorage)
    await world.idle()
})

test('a Blob the export could not read seeds as an empty Blob of its type, in its row', async () => {
    const world = createWorld()
    const tab = world.tab('a')
    const dump = sampleDump()
    const media = dump.stores.find((store) => store.name === 'media')!.records[0]!
    media.value = { blob: { $blobUnreadable: true, type: 'audio/mpeg', size: 3 }, size: 3 }
    assert.deepEqual(await tab.run(() => seedDump(tab.kv, readDump(dump), fakeStorage())), {
        seeded: true,
    })
    const seeded = withoutHandle(dump)
    seeded.stores.find((store) => store.name === 'media')!.records[0]!.value = {
        blob: { $blob: '', type: 'audio/mpeg' },
        size: 3,
    }
    const db = await tab.kv.open('nse-local-data', undefined)
    assert.deepEqual(await dumpOf(tab, db), seeded)
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

test("into an empty database the build made, meta is the dump's as one set", async () => {
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
    ;(await openLocalData(tab, DB_VERSION + 1)).close()
    const result = await tab.run(() => seedDump(tab.kv, sampleDump(), fakeStorage()))
    assert.equal(result.seeded, false)
    await world.idle()
})

test("the dumper writes a view's own bytes", () => {
    const buffer = new Uint8Array([0, 1, 2, 3, 4, 5]).buffer
    assert.deepEqual(encodeValue(new Uint8Array(buffer, 2, 2), noBlob), { $u8: b64([2, 3]) })
    assert.deepEqual(encodeValue(buffer, noBlob), { $ab: b64([0, 1, 2, 3, 4, 5]) })
    assert.deepEqual(encodeValue({ $a: [undefined] }, noBlob), {
        $$a: [{ $undefined: true }],
    })
})

test('a value with no plain tag is tagged, never thrown on, and comes back where it can', () => {
    const round = (value: unknown) => {
        const tagged = encodeValue({ value }, noBlob)
        return decodeValue(JSON.parse(JSON.stringify(tagged))) as { value: unknown }
    }
    // A number that is not finite, by its text.
    assert.deepEqual(encodeValue(NaN, noBlob), { $num: 'NaN' })
    assert.deepEqual(encodeValue(-Infinity, noBlob), { $num: '-Infinity' })
    assert.ok(Number.isNaN(round(NaN).value))
    assert.equal(round(Infinity).value, Infinity)
    assert.equal(round(-Infinity).value, -Infinity)
    // A Date, by its time value.
    assert.deepEqual(encodeValue(new Date(1234), noBlob), { $date: 1234 })
    assert.deepEqual(round(new Date(1234)).value, new Date(1234))
    assert.ok(Number.isNaN((round(new Date(NaN)).value as Date).getTime()))
    // Other typed arrays and a DataView, by their own bytes and the type's name.
    const wide = new Uint16Array([1, 258, 65535])
    assert.deepEqual(encodeValue(new Uint16Array(wide.buffer, 2, 1), noBlob), {
        $typed: 'Uint16Array',
        bytes: b64([2, 1]),
    })
    assert.deepEqual(round(wide).value, wide)
    assert.deepEqual(round(new Float64Array([1.5, NaN])).value, new Float64Array([1.5, NaN]))
    assert.deepEqual(round(new BigInt64Array([-5n])).value, new BigInt64Array([-5n]))
    const view = new DataView(new Uint8Array([9, 8, 7, 6]).buffer, 1, 2)
    assert.deepEqual(encodeValue(view, noBlob), { $typed: 'DataView', bytes: b64([8, 7]) })
    assert.deepEqual(new Uint8Array((round(view).value as DataView).buffer), new Uint8Array([8, 7]))
    // A subclass of Uint8Array, and a type this build does not know, come back as bytes.
    class Bytes extends Uint8Array {}
    assert.deepEqual(encodeValue(new Bytes([1, 2]), noBlob), {
        $typed: 'Bytes',
        bytes: b64([1, 2]),
    })
    assert.deepEqual(round(new Bytes([1, 2])).value, new Uint8Array([1, 2]))
    assert.deepEqual(
        decodeValue({ $typed: 'Uint16Array', bytes: b64([1, 2, 3]) }),
        new Uint8Array([1, 2, 3]),
    )
    // Anything else: the constructor's name and its text; a String() that throws, the name alone.
    class Thing {
        toString() {
            return 'a thing'
        }
    }
    class Bad {
        toString(): string {
            throw new Error('no')
        }
    }
    assert.deepEqual(encodeValue(new Thing(), noBlob), { $other: 'Thing', text: 'a thing' })
    assert.deepEqual(encodeValue(new Map(), noBlob), { $other: 'Map', text: '[object Map]' })
    assert.deepEqual(encodeValue(new Bad(), noBlob), { $other: 'Bad' })
    assert.deepEqual(encodeValue(1n, noBlob), { $other: 'bigint', text: '1' })
    assert.deepEqual(round(new Thing()), { value: undefined })
    // Inside arrays too.
    assert.deepEqual(encodeValue([NaN, new Thing()], noBlob), [
        { $num: 'NaN' },
        { $other: 'Thing', text: 'a thing' },
    ])
    for (const bad of [{ $num: 'one' }, { $date: 'x' }, { $typed: 'Uint8Array' }, { $other: 1 }])
        assert.throws(() => decodeValue(bad), DumpError)
})

test('a store with one NaN still exports the whole database, and the dump reads', async () => {
    const world = createWorld()
    const tab = world.tab('a')
    const db = await openLocalData(tab)
    await tab.run(() =>
        db.transaction(['sessions', 'chains'], 'readwrite', async (tx) => {
            await tx.put('chains', { chainId: 'c1', head: 's1', updatedAt: 1 })
            await tx.put('sessions', {
                id: 's1',
                chainId: 'c1',
                updatedAt: 2,
                view: { scroll: NaN, zoom: Infinity, at: new Date(5) },
            })
        }),
    )
    const dump = await dumpOf(tab, db)
    const rows = (name: string) => dump.stores.find((store) => store.name === name)!.records
    assert.equal(rows('chains').length, 1)
    assert.deepEqual(rows('sessions')[0]!.value, {
        id: 's1',
        chainId: 'c1',
        updatedAt: 2,
        view: { scroll: { $num: 'NaN' }, zoom: { $num: 'Infinity' }, at: { $date: 5 } },
    })
    readDump(JSON.parse(await new Blob(await dumpJsonBytes(dump)).text()))
    await world.idle()
})

test('a __proto__ key survives encoding, a JSON round trip and decoding', () => {
    const text = '{"extra":{"__proto__":{"kept":123},"other":1}}'
    const tagged = encodeValue(JSON.parse(text), noBlob)
    assert.equal(JSON.stringify(tagged), text)
    const decoded = decodeValue(JSON.parse(JSON.stringify(tagged)))
    assert.equal(JSON.stringify(decoded), text)
    // A key that starts with a dollar sign is escaped on the way out and restored on the way in.
    assert.deepEqual(decodeValue(encodeValue({ $a: 1 }, noBlob)), { $a: 1 })
})

test('the reader checks tags, base64, key order and in-line keys', () => {
    assert.throws(() => decodeValue({ $ab: 'AQ' }), /padded/)
    assert.throws(() => decodeValue({ $new: 1 }), /unknown tag/)
    // A Blob in a ZIP entry needs the ZIP, and names only `blobs/<n>`.
    assert.throws(() => decodeValue({ $blobEntry: 'blobs/0', type: '' }), /not given/)
    const entry = { blobEntry: (name: string) => name }
    assert.equal(decodeValue({ $blobEntry: 'blobs/12', type: '' }, entry), 'blobs/12')
    for (const name of ['blobs/01', 'dump.json', 'blobs/../x'])
        assert.throws(() => decodeValue({ $blobEntry: name, type: '' }, entry), /Not a Blob entry/)
    // A Blob the export could not read: `true`, its type and its size as a byte count.
    for (const bad of [
        { $blobUnreadable: false, type: '', size: 0 },
        { $blobUnreadable: true, type: 1, size: 0 },
        { $blobUnreadable: true, type: '', size: -1 },
        { $blobUnreadable: true, type: '', size: 0.5 },
    ])
        assert.throws(() => decodeValue(bad), DumpError)
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

test("localStorage: only the editor's keys, in order", () => {
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

test('the dump written in slices parses to the dump, however many records and slices', async (t) => {
    const parse = async (dump: Dump) =>
        JSON.parse(await new Blob(await dumpJsonBytes(dump)).text()) as unknown
    const sample = sampleDump()
    assert.deepEqual(await parse(sample), JSON.parse(JSON.stringify(sample)))
    const empty: Dump = { ...sample, stores: [], localStorage: {} }
    assert.deepEqual(await parse(empty), JSON.parse(JSON.stringify(empty)))
    // Many records, with a clock that moves a slice's length at every read: a slice per record.
    const many: Dump = {
        ...sample,
        stores: [
            { ...sample.stores[0]!, records: [] },
            {
                ...sample.stores[0]!,
                name: 'zz',
                records: Array.from({ length: 300 }, (_, i) => ({
                    key: `k${i}`,
                    value: {
                        text: 'é😀"\
'.repeat(i % 5),
                        n: i,
                    },
                })),
            },
        ],
    }
    let now = 0
    t.mock.method(performance, 'now', () => (now += 20))
    assert.deepEqual(await parse(many), JSON.parse(JSON.stringify(many)))
})
