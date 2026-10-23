import { PRODUCT_NAME } from '../product'
import { storageKey } from '../storage'
import { interpolateRaw } from '../utils/interpolate'
import { buildZip } from '../zip/writer'
import { DB_NAME } from './db'
import { DUMP_FORMAT, DUMP_VERSION, dumpDatabase, dumpLocalStorage, type Dump } from './dump'
import { idbFactory } from './kv/idb'
import type { KvFactory } from './kv/types'

// Export Raw Data… (Part 1 §1.4.14): everything this editor stored in this browser, as stored, in
// one ZIP. It runs on the page with no worker and decodes no record, so a bug in the code that
// failed can't stop it: it imports nothing under `local/records`, `local/nxsp` or
// `local/startup` (a unit test pins that). The way out when a storage bug ships.

/** The ZIP's one entry: the dump format, with Blobs as base64. */
export const DUMP_ENTRY = 'dump.json'

const emptyDump = (appVersion: string, localStorage: Record<string, string>): Dump => ({
    format: DUMP_FORMAT,
    version: DUMP_VERSION,
    appVersion,
    database: { name: DB_NAME, version: 1 },
    stores: [],
    localStorage,
})

/** What the export reads; the page's own IndexedDB and localStorage unless a test gives others. */
export type RawSources = {
    /** Undefined when this context has no IndexedDB. */
    factory?: KvFactory | undefined
    storage?: Storage | undefined
}

const pageSources = (): RawSources => {
    const sources: RawSources = {}
    // Either can throw on access when storage is blocked.
    try {
        if (typeof indexedDB !== 'undefined') sources.factory = idbFactory(indexedDB)
    } catch {
        // No IndexedDB here.
    }
    try {
        sources.storage = localStorage
    } catch {
        // No localStorage here.
    }
    return sources
}

/**
 * The database as it is, or none. The database is opened without a version and with
 * an upgrade that throws, so a missing one aborts the open and is never created: an empty
 * version-1 database would have no stores, and the editor's next open would not upgrade it.
 */
const openExisting = async (factory: KvFactory | undefined) => {
    try {
        return await factory?.open(DB_NAME, undefined, {
            upgrade: () => {
                throw new Error('There is no database to export')
            },
        })
    } catch {
        // No database, or storage unavailable here.
        return undefined
    }
}

/** The ZIP of the stored data; with no database or no storage it holds `localStorage` only. */
export const buildRawExport = async (
    appVersion: string,
    { factory, storage }: RawSources = pageSources(),
): Promise<Blob> => {
    let keys: Record<string, string> = {}
    try {
        if (storage) keys = dumpLocalStorage(storage, storageKey(''))
    } catch {
        // Storage can throw on access.
    }
    const db = await openExisting(factory)
    let dump: Dump
    try {
        dump = db
            ? await dumpDatabase(db, { appVersion, localStorage: keys })
            : emptyDump(appVersion, keys)
    } finally {
        db?.close()
    }
    const data = new TextEncoder().encode(JSON.stringify(dump))
    return buildZip([{ name: DUMP_ENTRY, method: 'deflate', data }])
}

/** A local date as 2026-10-23. */
export const dateStamp = (date: Date) =>
    [date.getFullYear(), date.getMonth() + 1, date.getDate()]
        .map((part, i) => String(part).padStart(i === 0 ? 4 : 2, '0'))
        .join('-')

/** "Next SEKAI Editor raw data 2026-10-23.zip", the pattern being the locale's. */
export const rawExportName = (pattern: string, now: Date = new Date()) =>
    interpolateRaw(pattern, PRODUCT_NAME, dateStamp(now))

/** Builds the file and hands it over; `save` is the platform's download. Throws on failure. */
export const exportRawData = async (
    appVersion: string,
    name: string,
    save: (name: string, blob: Blob) => Promise<unknown>,
) => {
    await save(name, await buildRawExport(appVersion))
}
