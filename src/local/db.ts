import { NO_USE_DAY, type UseDay } from './days'
import type { KvTx, KvUpgrade } from './kv/types'

// The database `nse-local-data` (Part 1 §1.6.11.2; `DB_VERSION` 1, whose store set is `STORES_V1`)
// and the versioning rules (§1.6.1): upgrades
// only add stores, indexes and fields; nothing here or in any version deletes a store or the
// database, and there is no reset path. The upgrade interface has no delete at all.

export const DB_NAME = 'nse-local-data'
export const DB_VERSION = 1

type StoreSpec = {
    keyPath: string | readonly string[] | null
    indexes: Readonly<Record<string, string>>
}

/** Every store with its key and indexes (none unique or multi-entry). */
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
    recovered: { keyPath: 'id', indexes: {} },
    userAssets: { keyPath: 'key', indexes: { type: 'type' } },
    meta: { keyPath: 'key', indexes: {} },
} as const satisfies Record<string, StoreSpec>

export type StoreName = keyof typeof STORES_V1

export const STORE_NAMES = Object.keys(STORES_V1) as StoreName[]

/** The `meta` rows and their starting values, written when the database is created. */
export type MetaValues = {
    formatVersion: number
    createdBy: string
    epoch: number
    maxSeenTime: number
    dbInstanceId: string
    deviceId: string
    daysOfUse: UseDay
    lastUseDate: string
    lastGcAt: { day: UseDay; time: number; unsafe?: true } | null
    deletionsPending: boolean
    migratedHashes: string[]
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
    daysOfUse: NO_USE_DAY,
    lastUseDate: '',
    lastGcAt: null,
    deletionsPending: false,
    migratedHashes: [],
})

const createV1 = (upgrade: KvUpgrade, context: CreateContext) => {
    for (const name of STORE_NAMES) {
        const spec: StoreSpec = STORES_V1[name]
        upgrade.createStore(name, spec.keyPath === null ? {} : { keyPath: spec.keyPath })
        for (const [index, keyPath] of Object.entries(spec.indexes))
            upgrade.createIndex(name, index, keyPath)
    }
    for (const [key, value] of Object.entries(startingMeta(context)))
        upgrade.put('meta', { key, value })
}

/** Each version's additive step; a version without one (a test's empty upgrade) adds nothing. */
const UPGRADES: Record<number, (upgrade: KvUpgrade, context: CreateContext) => void> = {
    1: createV1,
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
 * Bumps the epoch: in every transaction that deletes a body (`nodes`, `chunks`, `media`), so a
 * flush's closure check re-checks the hashes it reuses (R2). Removing rows bumps nothing.
 */
export const bumpEpoch = async (tx: KvTx) => {
    const epoch = (await readEpoch(tx)) + 1
    await writeMeta(tx, 'epoch', epoch)
    return epoch
}
