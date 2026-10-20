import type { Key, KvTx, KvUpgrade } from './kv/types'

// The database `nse-local-data` (Part 1 §1.6.11.2; `DB_VERSION` 2, the second generation, whose store set is
// `STORES_V1` under its first name) and the versioning rules (§1.6.1): upgrades
// only add stores, indexes and fields; nothing here or in any version deletes a store or the
// database, and there is no reset path. The upgrade interface has no delete at all.

export const DB_NAME = 'nse-local-data'
export const DB_VERSION = 2

type StoreSpec = {
    keyPath: string | readonly string[] | null
    indexes: Readonly<Record<string, string>>
}

/** Every store with its key and indexes (none unique or multi-entry); `STORES_V1` is the name the set was first given. */
export const STORES_V1 = {
    chains: { keyPath: 'chainId', indexes: { updatedAt: 'updatedAt', docId: 'docId' } },
    // A chain's file handles by role, off its record (D24).
    handles: { keyPath: ['chainId', 'role'], indexes: {} },
    sessions: { keyPath: 'id', indexes: { updatedAt: 'updatedAt', chainId: 'chainId' } },
    entries: { keyPath: ['sessionId', 'seq'], indexes: {} },
    stackBlocks: { keyPath: ['sessionId', 'block'], indexes: {} },
    // Out-of-line keys: the 16-byte hash as an ArrayBuffer.
    nodes: { keyPath: null, indexes: {} },
    chunks: { keyPath: null, indexes: {} },
    media: { keyPath: null, indexes: {} },
    tombstones: { keyPath: 'id', indexes: {} },
    recovered: { keyPath: 'id', indexes: {} },
    userAssets: { keyPath: 'key', indexes: { type: 'type' } },
    meta: { keyPath: 'key', indexes: {} },
} as const satisfies Record<string, StoreSpec>

export type StoreName = keyof typeof STORES_V1

export const STORE_NAMES = Object.keys(STORES_V1) as StoreName[]

/** The `meta` rows and their starting values, written by the upgrade from version 0. */
export type MetaValues = {
    formatVersion: number
    createdBy: string
    epoch: number
    maxSeenTime: number
    dbInstanceId: string
    deviceId: string
    daysOfUse: number
    lastUseDate: string
    lastGcAt: { day: number; time: number } | null
    deletionsPending: boolean
    migratedHashes: string[]
    usage: {
        history: number
        media: number
        cachedMedia: number
        assets: number
        at: number
    } | null
    lastPersistFailure: { at: number; reason: string } | null
}

export type MetaKey = keyof MetaValues

/** §1.6.11.8's formatVersion that this build writes. */
export const FORMAT_VERSION = 1

export type CreateContext = {
    appVersion: string
    /** This browser's deviceId from localStorage, when it has one. */
    deviceId?: string
    randomId: () => string
}

export const startingMeta = (context: CreateContext): MetaValues => ({
    formatVersion: FORMAT_VERSION,
    createdBy: context.appVersion,
    epoch: 0,
    maxSeenTime: 0,
    dbInstanceId: context.randomId(),
    deviceId: context.deviceId ?? context.randomId(),
    daysOfUse: 0,
    lastUseDate: '',
    lastGcAt: null,
    deletionsPending: false,
    migratedHashes: [],
    usage: null,
    lastPersistFailure: null,
})

/** Creates each store of the set the database lacks, with its indexes. */
const createMissingStores = (upgrade: KvUpgrade) => {
    const present = new Set(upgrade.storeNames)
    for (const name of STORE_NAMES) {
        if (present.has(name)) continue
        const spec: StoreSpec = STORES_V1[name]
        upgrade.createStore(name, spec.keyPath === null ? {} : { keyPath: spec.keyPath })
        for (const [index, keyPath] of Object.entries(spec.indexes))
            upgrade.createIndex(name, index, keyPath)
    }
}

const createV1 = (upgrade: KvUpgrade, context: CreateContext) => {
    createMissingStores(upgrade)
    for (const [key, value] of Object.entries(startingMeta(context)))
        upgrade.put('meta', { key, value })
}

/**
 * Each version's additive step; a version without one (a test's empty upgrade) adds nothing.
 * Version 2 adds any store of the set a version 1 database made before that store joined it
 * (`handles`), so no store this build writes is missing.
 */
const UPGRADES: Record<number, (upgrade: KvUpgrade, context: CreateContext) => void> = {
    1: createV1,
    2: createMissingStores,
}

/** The upgrade callback from any older version to the one requested. */
export const upgradeDatabase = (context: CreateContext) => (upgrade: KvUpgrade) => {
    for (let version = upgrade.oldVersion + 1; version <= upgrade.newVersion; version++)
        UPGRADES[version]?.(upgrade, context)
}

/** A hash as a key: exactly its 16 bytes, never a view into a larger buffer. */
export const hashKey = (hash: Uint8Array): ArrayBuffer => {
    if (hash.byteLength !== 16) throw new RangeError('A hash is 16 bytes')
    return hash.slice().buffer
}

type MetaRow = { key: string; value: unknown }

const isMetaRow = (row: unknown): row is MetaRow =>
    typeof row === 'object' && row !== null && 'key' in row

/** A `meta` value, undefined when the row is missing. */
export const readMeta = async <K extends MetaKey>(
    tx: KvTx,
    key: K,
): Promise<MetaValues[K] | undefined> => {
    const row = await tx.get('meta', key)
    return isMetaRow(row) ? (row.value as MetaValues[K]) : undefined
}

/** Writes a `meta` value, keeping any other field a newer build put on the row. */
export const writeMeta = async <K extends MetaKey>(tx: KvTx, key: K, value: MetaValues[K]) => {
    const row = await tx.get('meta', key)
    await tx.put('meta', { ...(isMetaRow(row) ? row : {}), key, value })
}

/** `meta.epoch`, read inside every flush's transaction (§1.6.6). */
export const readEpoch = async (tx: KvTx) => (await readMeta(tx, 'epoch')) ?? 0

/**
 * Bumps the epoch: only in a transaction that actually deleted something (§1.6.6). Unwired until
 * Step 8 GC: every transaction that deletes must call it.
 */
export const bumpEpoch = async (tx: KvTx) => {
    const epoch = (await readEpoch(tx)) + 1
    await writeMeta(tx, 'epoch', epoch)
    return epoch
}

/** The stores a stored hash can live in, as `refs` reach them. */
export const HASH_STORES = ['nodes', 'chunks', 'media'] as const satisfies StoreName[]

/**
 * The closure check (§1.6.6, r12-arch-web M5): which of these hashes no store holds. Run in the
 * flush's transaction after an epoch change, over `HASH_STORES` in its scope. Unwired until Step 8
 * GC, the first thing that changes the epoch.
 */
export const missingHashes = async (tx: KvTx, hashes: Iterable<Uint8Array>) => {
    const missing: Uint8Array[] = []
    for (const hash of hashes) {
        const key: Key = hashKey(hash)
        let found = false
        for (const store of HASH_STORES)
            if ((await tx.getKey(store, key)) !== undefined) {
                found = true
                break
            }
        if (!found) missing.push(hash)
    }
    return missing
}
