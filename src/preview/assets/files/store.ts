import { shallowRef } from 'vue'
import { metaOf, type UserAssetMeta, type UserAssetRecord } from '../../../local/userAssets'

export type { UserAssetMeta, UserAssetRecord }

/** The stored preview packages (`userAssets`, Part 1 §1.5.8): the storage worker's, or a fake. */
export type UserAssetStore = {
    list: () => Promise<UserAssetMeta[]>
    get: (key: string) => Promise<UserAssetRecord | undefined>
    put: (record: UserAssetRecord) => Promise<UserAssetMeta>
    /** Marks a package as used now. */
    touch: (key: string) => Promise<void>
    remove: (key: string) => Promise<void>
}

/** A store in memory, for tests and for a page whose storage did not start. */
export const createMemoryStore = (now: () => number = Date.now): UserAssetStore => {
    const rows = new Map<string, UserAssetRecord>()
    return {
        list: () =>
            Promise.resolve([...rows.values()].map(metaOf).sort((a, b) => b.addedAt - a.addedAt)),
        get: (key) => Promise.resolve(rows.get(key)),
        put: (record) => {
            const existing = rows.get(record.key)
            const row = existing ? { ...record, addedAt: existing.addedAt } : record
            rows.set(row.key, row)
            return Promise.resolve(metaOf(row))
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

/**
 * The storage worker's store. The worker starts after first paint, so a request made before that
 * waits for it; the page that loads a stored choice at startup is the usual one. The local-data
 * module is imported dynamically, as everywhere, so the main bundle does not carry it.
 */
export const workerStore: UserAssetStore = (() => {
    const worker = async () => {
        const start = await import('../../../local/start')
        for (let waited = 0; !start.storageWorker; waited += 50) {
            if (waited >= WORKER_WAIT_MS) throw new Error('The storage worker did not start')
            await new Promise((resolve) => setTimeout(resolve, 50))
        }
        return start.storageWorker
    }
    return {
        list: async () => (await worker()).call('userAssetList'),
        get: async (key) => (await worker()).call('userAssetGet', key),
        // A large package may take a while to reach the disk.
        put: async (record) => (await worker()).call('userAssetPut', record, { bulk: true }),
        touch: async (key) => {
            await (await worker()).call('userAssetTouch', { key, time: Date.now() })
        },
        remove: async (key) => {
            await (await worker()).call('userAssetRemove', key)
        },
    }
})()

/** The packages stored on this device, for the dialog's lists and footer; loaded when it opens. */
export const storedAssets = shallowRef<UserAssetMeta[]>([])

export const refreshStored = async (store: UserAssetStore = workerStore) => {
    try {
        storedAssets.value = await store.list()
    } catch {
        // Nothing to list where storage did not start.
    }
}
