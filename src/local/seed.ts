import { DB_NAME } from './db'
import { decodeValue, readDump, type Dump } from './dump'
import { HANDLES } from './handleRows'
import { idbFactory } from './kv/idb'
import type { KvFactory } from './kv/types'

const hasHandle = (value: unknown) =>
    typeof value === 'object' && value !== null && 'handle' in value

// The dev-only sample seeder: `?seedSample=<name>` loads `/samples/<name>.json`, a dump
// (Part 1 §1.6.11.9), into a database with no chains and no sessions, then reloads. Imported only
// under `import.meta.env.DEV`, so release builds have none of it.

export type SeedResult = { seeded: true } | { seeded: false; reason: string }

const refuse = (reason: string): SeedResult => ({ seeded: false, reason })

/** Writes a dump's rows and localStorage keys, only into a database with no chains and no sessions. */
export const seedDump = async (
    factory: KvFactory,
    dump: Dump,
    storage: Pick<Storage, 'setItem'>,
): Promise<SeedResult> => {
    if (dump.database.name !== DB_NAME) return refuse(`The dump is of ${dump.database.name}`)
    for (const store of dump.stores)
        if (store.autoIncrement || store.indexes.some((index) => index.unique || index.multiEntry))
            return refuse(`Store ${store.name} has options the seeder does not create`)
    const rows = dump.stores.map((store) => ({
        name: store.name,
        records: store.records
            .map((record) => ({
                key: store.keyPath === null ? (decodeValue(record.key) as never) : undefined,
                value: decodeValue(record.value),
            }))
            // A handle can't be dumped: its row, left without one, isn't seeded (D24).
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
        const response = await fetch(`/samples/${name}.json`)
        if (!response.ok) throw new Error(`/samples/${name}.json: ${response.status}`)
        const dump = readDump(await response.json())
        const result = await seedDump(idbFactory(indexedDB), dump, localStorage)
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
