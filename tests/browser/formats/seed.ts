import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { deflateChunk } from '../../../src/local/chunkVerify'
import { decodeValue, toBase64 } from '../../../src/local/dump'
import { hash16Sync, toHex } from '../../../src/local/hash'
import { compareKeys, normalizeKey } from '../../../src/local/kv/keys'
import type { Key } from '../../../src/local/kv/types'
import { canonicalBytes } from '../../../src/local/records/canonical'
import { chunkCrc32 } from '../../../src/local/records/rows'
import { SampleClock } from '../../samples/driver'
import { waitForStartup } from '../editorFixture'

// Seeding a profile from a v1 dump (tests/fixtures/web-storage-v1/): a blank same-origin page loads
// the seeder alone and writes the database and localStorage before the editor first loads in the
// context, as a maintainer loads a user's dump (docs/release/storage-bug.md).

export const webDir = resolve(import.meta.dirname, '../../fixtures/web-storage-v1')

export const prefix = 'sonolus-next-sekai-editor.'

const DAY = 24 * 60 * 60 * 1000

type Row = Record<string, unknown>

export type DumpJson = {
    appVersion: string
    stores: { name: string; records: { key: unknown; value: Row }[] }[]
    localStorage: Record<string, string>
}

export const readFixture = (name: string) =>
    JSON.parse(readFileSync(join(webDir, name), 'utf8')) as DumpJson

export const valuesOf = (dump: DumpJson, store: string) =>
    (dump.stores.find((each) => each.name === store)?.records ?? []).map((record) => record.value)

/** The stores that hold Blobs: WebKit's private contexts refuse them in IndexedDB. */
export const BLOB_STORES = ['media', 'recovered', 'userAssets']

/** The chains of the main dump by the letters the scenario uses (Part 1 §1.6.11.9). */
export const chainsOf = (dump: DumpJson) => {
    const chains = valuesOf(dump, 'chains')
    const sessions = valuesOf(dump, 'sessions')
    const pick = (what: string, found: Row[]) => {
        expect(found, what).toHaveLength(1)
        return found[0]!.chainId as string
    }
    const pending = sessions.filter((row) => row.importPending === true)
    const migrated = sessions.filter((row) => row.origin === 'migrated')
    return {
        A: pick(
            'A',
            chains.filter((chain) => 'zzFixtureChainField' in chain),
        ),
        F: pick(
            'F',
            chains.filter((chain) => chain.replaced !== undefined),
        ),
        I: pick(
            'I',
            chains.filter((chain) => chain.sourceName === 'imported-level'),
        ),
        M: pick(
            'M',
            chains.filter((chain) => chain.chainId === migrated[0]?.chainId),
        ),
        N: pick(
            'N',
            chains.filter((chain) => chain.deleting !== undefined),
        ),
        P: pick(
            'P',
            chains.filter((chain) => chain.partialImport === true),
        ),
        Q: pick(
            'Q',
            chains.filter((chain) => chain.chainId === pending[0]?.chainId),
        ),
    }
}

/** The dump's last day of use, as a time: midnight (UTC) after `maxSeenTime`, plus `days`. */
export const afterDump = (dump: DumpJson, days: number, hours = 10) => {
    const meta = valuesOf(dump, 'meta').find((row) => row.key === 'maxSeenTime')
    const seen = meta?.value as number
    return Math.floor(seen / DAY) * DAY + days * DAY + hours * 60 * 60 * 1000
}

export type SeedOptions = {
    /** The clock's start (the page's clock and the storage worker's Date). */
    start: number
    /** 'opfs' makes the save and open pickers return files of the origin private file system. */
    files?: 'opfs' | 'download'
    /** Stores whose rows are left out of the seed. */
    without?: string[]
    /** An Export Raw Data… ZIP to seed through `seedRawExport`, in place of the dump's JSON. */
    zip?: Uint8Array
}

/** A context whose profile holds the dump (an empty one without), ready for the editor's first load. */
export const seededContext = async (
    browser: Browser,
    json: DumpJson | undefined,
    { start, files = 'download', without = [], zip }: SeedOptions,
): Promise<{ context: BrowserContext; clock: SampleClock }> => {
    const context = await browser.newContext({ timezoneId: 'UTC', locale: 'en-US' })
    const clock = new SampleClock(context, start)
    await clock.install()
    await context.addInitScript(
        ({ files, prefix }) => {
            // The sample driver finds the app's modules in the resource timing entries.
            performance.setResourceTimingBufferSize(5000)
            localStorage.setItem('nse.test.storage', '{}')
            localStorage.setItem(
                'nse.test.platform',
                JSON.stringify({ fileSystemAccess: files === 'opfs' ? 'opfs' : false }),
            )
            localStorage.setItem(`${prefix}showPreview`, 'false')
            localStorage.setItem(`${prefix}showMinimap`, 'false')
        },
        { files, prefix },
    )
    if (!json && !zip) return { context, clock }
    const dump = json && {
        ...json,
        stores: json.stores.map((store) =>
            without.includes(store.name) ? { ...store, records: [] } : store,
        ),
    }
    const page = await context.newPage()
    await page.goto('/privacy/')
    const result = await page.evaluate(async ({ dump, zip }) => {
        const { seedDump } =
            (await import('/src/local/seed.ts')) as typeof import('../../../src/local/seed')
        const { readDump } =
            (await import('/src/local/dump.ts')) as typeof import('../../../src/local/dump')
        const { idbFactory } =
            (await import('/src/local/kv/idb.ts')) as typeof import('../../../src/local/kv/idb')
        if (zip) {
            const { seedRawExport } =
                (await import('/src/local/seed.ts')) as typeof import('../../../src/local/seed')
            return seedRawExport(idbFactory(indexedDB), new Blob([new Uint8Array(zip)]), localStorage)
        }
        return seedDump(idbFactory(indexedDB), readDump(dump), localStorage)
    }, { dump, zip: zip && [...zip] })
    expect(result).toEqual({ seeded: true })
    await page.close()
    return { context, clock }
}

/** A new tab on the editor, once startup has opened the session it continues. */
export const visit = async (context: BrowserContext, clock?: SampleClock) => {
    const page = await context.newPage()
    clock?.track(page)
    await page.goto('/')
    await expect(page.locator('canvas.editor-chart')).toBeVisible()
    await waitForStartup(page)
    return page
}

/** Every row of some stores, read through the storage worker. */
export const rowsOf = (page: Page, stores: string[]) =>
    page.evaluate(
        (stores) =>
            window.nseStorageTest!.worker.call('testRows', stores) as Promise<
                Record<string, { key: unknown; value: Row }[]>
            >,
        stores,
    )

/** The localStorage keys under the editor's prefix, without it. */
export const storageKeys = (page: Page) =>
    page.evaluate((prefix) => {
        const found: string[] = []
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i)
            if (key?.startsWith(prefix)) found.push(key.slice(prefix.length))
        }
        return found
    }, prefix)

const KNOWN_KINDS = [
    'init',
    'continue',
    'edit',
    'undo',
    'redo',
    'restore',
    'save',
    'export',
    'recovered',
]

/**
 * The dump without the data only a later build writes (the sessions that hold an entry of an unknown
 * kind, their entries, and the chain heads moved back to their parents): a GC pass that finds newer
 * data stops without deleting, so a test of what GC deletes seeds without it.
 */
export const withoutNewerData = (json: DumpJson): DumpJson => {
    const unknown = valuesOf(json, 'entries').filter(
        (entry) => !KNOWN_KINDS.includes(entry.kind as string),
    )
    const sessionIds = new Set(unknown.map((entry) => entry.sessionId as string))
    const sessions = valuesOf(json, 'sessions')
    const parents = new Map(
        sessions.flatMap((session) =>
            sessionIds.has(session.id as string)
                ? [[session.id as string, (session.parent as { id: string }).id] as const]
                : [],
        ),
    )
    return {
        ...json,
        stores: json.stores.map((store) => {
            if (store.name === 'sessions')
                return {
                    ...store,
                    records: store.records.filter(
                        (record) => !sessionIds.has(record.value.id as string),
                    ),
                }
            if (store.name === 'entries')
                return {
                    ...store,
                    records: store.records.filter(
                        (record) => !sessionIds.has(record.value.sessionId as string),
                    ),
                }
            if (store.name === 'stackBlocks')
                return {
                    ...store,
                    records: store.records.filter(
                        (record) => !sessionIds.has(record.value.sessionId as string),
                    ),
                }
            if (store.name === 'chains')
                return {
                    ...store,
                    records: store.records.map((record) =>
                        parents.has(record.value.head as string)
                            ? {
                                  ...record,
                                  value: {
                                      ...record.value,
                                      head: parents.get(record.value.head as string),
                                  },
                              }
                            : record,
                    ),
                }
            return store
        }),
    }
}

/**
 * The dump with one chunk no row names, first stored on the dump's first day: a body only GC can
 * remove. Returns the dump and the chunk's hash as hex.
 */
export const withOrphanChunk = (json: DumpJson): { dump: DumpJson; hash: string } => {
    const bytes = canonicalBytes(['an orphan the fixture adds'])
    const key = hash16Sync(bytes)
    const stored = deflateChunk(bytes)
    const record = {
        key: { $ab: toBase64(key) },
        value: {
            bytes: { $u8: toBase64(stored) },
            size: bytes.length,
            crc32: chunkCrc32(key, stored),
            day: 1,
        },
    }
    const order = (value: unknown) => normalizeKey(decodeValue(value)) as Key
    return {
        hash: toHex(key),
        dump: {
            ...json,
            stores: json.stores.map((store) =>
                store.name === 'chunks'
                    ? {
                          ...store,
                          records: [...store.records, record as never].sort((a, b) =>
                              compareKeys(order(a.key), order(b.key)),
                          ),
                      }
                    : store,
            ),
        },
    }
}
