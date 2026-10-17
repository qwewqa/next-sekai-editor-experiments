import { shallowRef } from 'vue'
import {
    metaOf,
    type UserAssetMeta,
    type UserAssetRecord,
    type UserAssetsPut,
} from '../../../local/userAssets'
import type { StorageStatus } from '../../../local/worker/core'

export type { UserAssetMeta, UserAssetRecord, UserAssetsPut }

/** The stored preview packages (`userAssets`, Part 1 §1.5.8): the storage worker's, or a fake. */
export type UserAssetStore = {
    list: () => Promise<UserAssetMeta[]>
    get: (key: string) => Promise<UserAssetRecord | undefined>
    put: (record: UserAssetRecord) => Promise<UserAssetMeta>
    /** Stores several packages together: all of them, or none. */
    putMany: (records: UserAssetRecord[]) => Promise<UserAssetsPut>
    /** Marks a package as used now. */
    touch: (key: string) => Promise<void>
    remove: (key: string) => Promise<void>
    /** False while this browser's storage cannot be opened, so what it holds cannot be read. */
    isAvailable?: () => boolean
}

/** The store cannot be read: its storage did not open, or the storage worker did not start. */
export class StoreUnavailableError extends Error {
    override name = 'StoreUnavailableError'
}

/** A store in memory, for tests and for a page whose storage did not start. */
export const createMemoryStore = (now: () => number = Date.now): UserAssetStore => {
    const rows = new Map<string, UserAssetRecord>()
    const putOne = (record: UserAssetRecord) => {
        const existing = rows.get(record.key)
        const row = existing ? { ...record, addedAt: existing.addedAt } : record
        rows.set(row.key, row)
        return metaOf(row)
    }
    return {
        list: () =>
            Promise.resolve([...rows.values()].map(metaOf).sort((a, b) => b.addedAt - a.addedAt)),
        get: (key) => Promise.resolve(rows.get(key)),
        put: (record) => Promise.resolve(putOne(record)),
        putMany: (records) => {
            const added = [
                ...new Set(records.map((record) => record.key).filter((key) => !rows.has(key))),
            ]
            return Promise.resolve({ metas: records.map(putOne), added })
        },
        touch: (key) => {
            const row = rows.get(key)
            if (row) rows.set(key, { ...row, lastUsedAt: now() })
            return Promise.resolve()
        },
        remove: (key) => {
            rows.delete(key)
            return Promise.resolve()
        },
    }
}

/** How long a request waits for the storage worker to start before it gives up. */
const WORKER_WAIT_MS = 15_000

/** What the store needs of the storage worker. */
export type StoreWorker = {
    status: StorageStatus | undefined
    call: (method: string, arg?: unknown, options?: { bulk?: boolean }) => Promise<unknown>
}

/**
 * A store over the storage worker. Where storage did not open, the worker runs on an empty
 * in-memory database, so a package it does not find there may well be stored: that reads as
 * unavailable, not as gone.
 */
export const createWorkerStore = (worker: () => Promise<StoreWorker>): UserAssetStore => {
    let last: StoreWorker | undefined
    const ready = async () => (last = await worker())
    const call = async <T>(method: string, arg?: unknown, options?: { bulk?: boolean }) =>
        (await (await ready()).call(method, arg, options)) as T
    return {
        list: () => call<UserAssetMeta[]>('userAssetList'),
        get: async (key) => {
            const record = await call<UserAssetRecord | undefined>('userAssetGet', key)
            if (!record && last?.status?.mode === 'memory')
                throw new StoreUnavailableError('Storage did not open')
            return record
        },
        // A large package may take a while to reach the disk.
        put: (record) => call<UserAssetMeta>('userAssetPut', record, { bulk: true }),
        putMany: (records) => call<UserAssetsPut>('userAssetPutMany', records, { bulk: true }),
        touch: async (key) => {
            await call('userAssetTouch', { key, time: Date.now() })
        },
        remove: async (key) => {
            await call('userAssetRemove', key)
        },
        isAvailable: () => last?.status?.mode !== 'memory',
    }
}

/**
 * The storage worker's store. The worker starts after first paint, so a request made before that
 * waits for it; the page that loads a stored choice at startup is the usual one. The local-data
 * module is imported dynamically, as everywhere, so the main bundle does not carry it.
 */
export const workerStore: UserAssetStore = createWorkerStore(async () => {
    const start = await import('../../../local/start')
    for (let waited = 0; !start.storageWorker; waited += 50) {
        if (waited >= WORKER_WAIT_MS)
            throw new StoreUnavailableError('The storage worker did not start')
        await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return start.storageWorker as unknown as StoreWorker
})

/** The packages stored on this device, for the dialog's lists and footer; loaded when it opens. */
export const storedAssets = shallowRef<UserAssetMeta[]>([])
/** Whether the list has been read once, so the Stored tab does not say "empty" before it is read. */
export const storedLoaded = shallowRef(false)
/** Whether this browser's storage could not be opened, so the list is not what is stored. */
export const storedUnavailable = shallowRef(false)

export const refreshStored = async (store: UserAssetStore = workerStore) => {
    try {
        storedAssets.value = await store.list()
        storedUnavailable.value = store.isAvailable?.() === false
    } catch {
        storedUnavailable.value = true
    }
    storedLoaded.value = true
}
