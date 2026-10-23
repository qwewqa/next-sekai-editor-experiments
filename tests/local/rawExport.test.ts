import assert from 'node:assert/strict'
import test from 'node:test'
import { DB_NAME, STORES_V1 } from '../../src/local/db'
import { dumpDatabase, readDump, toBase64, type Dump } from '../../src/local/dump'
import type { KvDatabase, KvFactory } from '../../src/local/kv/types'
import {
    buildRawExport,
    buildRawExportResult,
    dateStamp,
    DUMP_ENTRY,
    exportRawData,
    rawExportName,
    type RawSources,
} from '../../src/local/rawExport'
import { seedDump } from '../../src/local/seed'
import { createWorld, type Tab } from '../../src/local/testing/world'
import { storageKey } from '../../src/storage'
import { ZipReader } from '../../src/zip'

// Export Raw Data… (Part 1 §1.4.14, Step 8 design §3.9).

const b64 = (bytes: number[]) => toBase64(new Uint8Array(bytes))

const hash = (n: number) => ({ $ab: b64(Array.from({ length: 16 }, (_, i) => (i + n) % 256)) })

/** A dump with rows in every kind of store, one chain row no decoder could read, and a Blob. */
const stored = (): Dump => ({
    format: 'nse-local-data-dump',
    version: 1,
    appVersion: '0.6.0',
    database: { name: DB_NAME, version: 1 },
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
                              key: 'bad',
                              value: { chainId: 'bad', head: 12, zzFuture: [1, { a: 2 }] },
                          },
                          { key: 'c1', value: { chainId: 'c1', head: 's1', updatedAt: 5 } },
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
                                ]
                              : [],
        })),
    localStorage: {
        [storageKey('canary')]: '"db-x"',
        [storageKey('journal.s1')]: 'a pending journal',
    },
})

/** A Storage over a map. */
const fakeStorage = (items: Record<string, string>): Storage => {
    const map = new Map(Object.entries(items))
    return {
        get length() {
            return map.size
        },
        key: (index: number) => [...map.keys()][index] ?? null,
        getItem: (key: string) => map.get(key) ?? null,
        setItem: (key: string, value: string) => {
            map.set(key, value)
        },
        removeItem: (key: string) => {
            map.delete(key)
        },
        clear: () => {
            map.clear()
        },
    }
}

/** The editor's keys, and one that is not its own. */
const withForeign = (items: Record<string, string>) => ({ ...items, 'someone.else': 'not ours' })

const dumpOf = (tab: Tab, db: KvDatabase) =>
    tab.run(() => dumpDatabase(db, { appVersion: '0.6.0', localStorage: {} }))

/** The dump.json inside the exported ZIP, which holds nothing else. */
const readExport = async (zip: Blob) => {
    const reader = await ZipReader.open(zip)
    assert.deepEqual(
        reader.entries.map((entry) => entry.name),
        [DUMP_ENTRY],
    )
    const entry = reader.get(DUMP_ENTRY)!
    return JSON.parse(
        new TextDecoder().decode(await reader.read(entry, { maxSize: 64 * 1024 * 1024 })),
    ) as unknown
}

test('a seeded profile exports to one dump that seeds the same profile again', async () => {
    const world = createWorld()
    const tab = world.tab('a')
    const dump = stored()
    const noStorage = { setItem: () => undefined }
    assert.deepEqual(await tab.run(() => seedDump(tab.kv, readDump(dump), noStorage)), {
        seeded: true,
    })
    const sources: RawSources = {
        factory: tab.kv,
        storage: fakeStorage(withForeign(dump.localStorage)),
    }
    const zip = await tab.run(() => buildRawExport('0.6.0', sources))
    const exported = readDump(await readExport(zip))
    // Everything stored, undecoded, with only the editor's own localStorage keys.
    assert.deepEqual(exported, dump)
    // And it loads: a fresh profile seeded from the export holds the same rows.
    const other = createWorld()
    const otherTab = other.tab('b')
    assert.deepEqual(await otherTab.run(() => seedDump(otherTab.kv, exported, fakeStorage({}))), {
        seeded: true,
    })
    const again = await otherTab.kv.open(DB_NAME, undefined)
    assert.deepEqual(await dumpOf(otherTab, again), { ...dump, localStorage: {} })
    await world.idle()
    await other.idle()
})

test('a missing database is not created, and the export holds localStorage only', async () => {
    const world = createWorld()
    const tab = world.tab('a')
    const keys = { [storageKey('canary')]: '"x"' }
    const sources: RawSources = { factory: tab.kv, storage: fakeStorage(withForeign(keys)) }
    const zip = await tab.run(() => buildRawExport('0.6.0', sources))
    assert.equal(world.memory.version(DB_NAME), 0)
    const exported = readDump(await readExport(zip))
    assert.deepEqual(exported.stores, [])
    assert.deepEqual(exported.localStorage, keys)
    await world.idle()
})

test('with storage unavailable the export holds localStorage only', async () => {
    const keys = { [storageKey('canary')]: '"x"' }
    const noDatabase = readDump(
        await readExport(await buildRawExport('0.6.0', { storage: fakeStorage(keys) })),
    )
    assert.deepEqual(noDatabase.stores, [])
    assert.deepEqual(noDatabase.localStorage, keys)
    // Neither: an empty dump, not an error.
    const neither = readDump(await readExport(await buildRawExport('0.6.0', {})))
    assert.deepEqual(neither.localStorage, {})
    // A localStorage that throws on access is left out the same way.
    const throwing = {
        get length(): number {
            throw new DOMException('denied', 'SecurityError')
        },
    } as unknown as Storage
    const blocked = readDump(await readExport(await buildRawExport('0.6.0', { storage: throwing })))
    assert.deepEqual(blocked.localStorage, {})
})

test('the file is named for the product and the local date', () => {
    assert.equal(dateStamp(new Date(2026, 9, 23, 23, 59)), '2026-10-23')
    assert.equal(dateStamp(new Date(2026, 0, 5)), '2026-01-05')
    assert.equal(
        rawExportName('{0} raw data {1}.zip', new Date(2026, 9, 23)),
        'Next SEKAI Editor raw data 2026-10-23.zip',
    )
})

test('a database that exists but will not open is left out and said so, never taken for an empty one', async () => {
    const world = createWorld()
    const tab = world.tab('a')
    const dump = stored()
    await tab.run(() => seedDump(tab.kv, readDump(dump), { setItem: () => undefined }))
    const keys = { [storageKey('canary')]: '"x"' }
    const storage = fakeStorage(keys)
    // The browser refuses the open: the database is there, the export cannot read it.
    const refusing: RawSources = {
        factory: {
            ...tab.kv,
            open: () => Promise.reject(new DOMException('disk', 'UnknownError')),
        },
        storage,
    }
    const built = await buildRawExportResult('0.6.0', refusing)
    assert.equal(built.databaseUnreadable, true)
    // The localStorage side still goes, so the file has the journals.
    const exported = readDump(await readExport(built.zip))
    assert.deepEqual(exported.stores, [])
    assert.deepEqual(exported.localStorage, keys)
    // A database that opens but fails halfway is the same.
    const flaky: RawSources = {
        factory: {
            ...tab.kv,
            open: async (...args: Parameters<typeof tab.kv.open>) => {
                const db = await tab.kv.open(...args)
                return {
                    ...db,
                    storeNames: db.storeNames,
                    transaction: () => Promise.reject(new DOMException('read', 'UnknownError')),
                    close: () => db.close(),
                }
            },
        },
        storage,
    }
    const log = console.error
    console.error = () => undefined
    try {
        assert.equal((await buildRawExportResult('0.6.0', flaky)).databaseUnreadable, true)
    } finally {
        console.error = log
    }
    // And the plain cases are not reported: a readable database, a missing one, no storage.
    const fine = await buildRawExportResult('0.6.0', { factory: tab.kv, storage })
    assert.equal(fine.databaseUnreadable, false)
    const missing = await buildRawExportResult('0.6.0', {
        factory: createWorld().tab('m').kv,
        storage,
    })
    assert.equal(missing.databaseUnreadable, false)
    assert.equal((await buildRawExportResult('0.6.0', {})).databaseUnreadable, false)
    await world.idle()
})

test('exporting says whether the database was left out, and still throws when the hand-over fails', async () => {
    const refusing: RawSources = {
        factory: {
            open: () => Promise.reject(new DOMException('disk', 'UnknownError')),
        } as unknown as KvFactory,
        storage: fakeStorage({}),
    }
    const handed: string[] = []
    assert.deepEqual(
        await exportRawData(
            '0.6.0',
            'a.zip',
            (name) => {
                handed.push(name)
                return Promise.resolve()
            },
            refusing,
        ),
        { databaseUnreadable: true },
    )
    assert.deepEqual(handed, ['a.zip'])
    await assert.rejects(
        exportRawData('0.6.0', 'a.zip', () => Promise.reject(new Error('blocked')), refusing),
        /blocked/,
    )
})
