import { ZipReader } from '../zip'
import { DB_NAME } from './db'
import { decodeValue, DumpError, readDump, type Dump } from './dump'
import { HANDLES } from './handleRows'
import { idbFactory } from './kv/idb'
import type { KvFactory } from './kv/types'
import { DUMP_ENTRY } from './rawExport'

const hasHandle = (value: unknown) =>
    typeof value === 'object' && value !== null && 'handle' in value

// The sample seeder of dev and perf builds: `?seedSample=<name>` loads `/samples/<name>.json`, a
// dump, or `?seedSample=<name>.zip` an Export Raw Data… ZIP, into a database with no chains and no
// sessions, then reloads. Imported only under `import.meta.env.DEV` or `__NSE_PERF__`, so release
// builds have none of it.

export type SeedResult = { seeded: true } | { seeded: false; reason: string }

const refuse = (reason: string): SeedResult => ({ seeded: false, reason })

/**
 * Writes a dump's rows and localStorage keys, only into a database with no chains and no sessions.
 * `blobs` holds the ZIP entries its `$blobEntry` tags name.
 */
export const seedDump = async (
    factory: KvFactory,
    dump: Dump,
    storage: Pick<Storage, 'setItem'>,
    blobs: ReadonlyMap<string, Blob> = new Map(),
): Promise<SeedResult> => {
    const blobEntry = (name: string, type: string) => {
        const blob = blobs.get(name)
        if (!blob) throw new DumpError(`The ZIP has no ${name}`)
        return new Blob([blob], { type })
    }
    if (dump.database.name !== DB_NAME) return refuse(`The dump is of ${dump.database.name}`)
    for (const store of dump.stores)
        if (store.autoIncrement || store.indexes.some((index) => index.unique || index.multiEntry))
            return refuse(`Store ${store.name} has options the seeder does not create`)
    const rows = dump.stores.map((store) => ({
        name: store.name,
        records: store.records
            .map((record) => ({
                key: store.keyPath === null ? (decodeValue(record.key) as never) : undefined,
                value: decodeValue(record.value, { blobEntry }),
            }))
            // A handle can't be dumped: its row, left without one, isn't seeded.
            .filter(({ value }) => store.name !== HANDLES || hasHandle(value)),
    }))
    const opened = { created: false }
    let db
    try {
        db = await factory.open(DB_NAME, dump.database.version, {
            upgrade: (upgrade) => {
                // Only a new database: the dump's stores, indexes and rows, never the build's upgrade.
                if (upgrade.oldVersion !== 0) throw new Error('The database is older than the dump')
                for (const store of dump.stores) {
                    upgrade.createStore(
                        store.name,
                        store.keyPath === null ? {} : { keyPath: store.keyPath },
                    )
                    for (const index of store.indexes)
                        upgrade.createIndex(store.name, index.name, index.keyPath)
                }
                for (const store of rows)
                    for (const { key, value } of store.records) upgrade.put(store.name, value, key)
                opened.created = true
            },
        })
    } catch (error) {
        return refuse(`The database could not be opened at the dump’s version: ${String(error)}`)
    }
    try {
        if (!opened.created) {
            const names = dump.stores.map((store) => store.name)
            const missing = names.filter((name) => !db.storeNames.includes(name))
            if (missing.length) return refuse(`The database has no ${missing.join(', ')}`)
            if (!db.storeNames.includes('chains') || !db.storeNames.includes('sessions'))
                return refuse('The database has no chains or sessions store')
            // One transaction: the check and every row, including meta as one consistent set.
            const result = await db.transaction(names, 'readwrite', async (tx) => {
                const chains = await tx.count('chains')
                const sessions = await tx.count('sessions')
                if (chains || sessions)
                    return refuse(`The database has ${chains} chains and ${sessions} sessions`)
                for (const store of rows)
                    for (const { key, value } of store.records) await tx.put(store.name, value, key)
                return { seeded: true } as const
            })
            if (!result.seeded) return result
        }
    } finally {
        db.close()
    }
    for (const [key, value] of Object.entries(dump.localStorage)) storage.setItem(key, value)
    return { seeded: true }
}

/** Seeds an Export Raw Data… ZIP: its `dump.json`, each `$blobEntry` read from its own entry. */
export const seedRawExport = async (
    factory: KvFactory,
    zip: Blob,
    storage: Pick<Storage, 'setItem'>,
): Promise<SeedResult> => {
    const reader = await ZipReader.open(zip)
    const entry = reader.get(DUMP_ENTRY)
    if (!entry) return refuse(`The ZIP has no ${DUMP_ENTRY}`)
    const text = new TextDecoder().decode(await reader.read(entry, { maxSize: 2 ** 32 }))
    const dump = readDump(JSON.parse(text))
    const blobs = new Map<string, Blob>()
    // Each checked against its CRC as it is read, one at a time.
    for (const each of reader.entries)
        if (each.name.startsWith('blobs/') && !each.isDirectory)
            blobs.set(each.name, new Blob([await reader.read(each, { maxSize: 2 ** 32 })]))
    return seedDump(factory, dump, storage, blobs)
}

/**
 * The dev page's half: seeds the sample the URL names, then reloads without the parameter. A
 * refusal leaves the URL as it is, and the editor loads as usual.
 */
export const seedSampleFromUrl = async (): Promise<boolean> => {
    const url = new URL(location.href)
    const name = url.searchParams.get('seedSample')
    if (name === null) return false
    url.searchParams.delete('seedSample')
    const tag = '[seedSample]'
    try {
        if (!/^[\w.-]+$/.test(name)) throw new Error(`Not a sample name: ${name}`)
        const zip = name.endsWith('.zip')
        const path = `/samples/${zip ? name : `${name}.json`}`
        const response = await fetch(path)
        if (!response.ok) throw new Error(`${path}: ${response.status}`)
        const factory = idbFactory(indexedDB)
        const result = zip
            ? await seedRawExport(factory, await response.blob(), localStorage)
            : await seedDump(factory, readDump(await response.json()), localStorage)
        if (!result.seeded) {
            console.warn(`${tag} Refused, nothing changed. ${result.reason}`)
            return false
        }
        console.info(`${tag} Seeded ${name}; reloading.`)
        location.replace(url)
        return true
    } catch (error) {
        console.error(`${tag} Failed, nothing changed.`, error)
        return false
    }
}
