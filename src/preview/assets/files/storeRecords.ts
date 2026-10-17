import { sha256Hex } from './importer'
import type { UserAssetRecord, UserAssetStore } from './store'

/** Storing failed, or what was stored did not read back as written. */
export class StoreFailed extends Error {
    override name = 'StoreFailed'
}

/** Removes what a Use newly stored, when it is not to be used after all. */
export const rollBack = async (store: UserAssetStore, keys: string[]) => {
    await Promise.allSettled(keys.map((key) => store.remove(key)))
}

/** Stores the records together and reads each back, as media is, before it is used. */
export const storeRecords = async (store: UserAssetStore, records: UserAssetRecord[]) => {
    let stored
    try {
        stored = await store.putMany(records)
    } catch (error) {
        throw new StoreFailed('The packages could not be stored', { cause: error })
    }
    try {
        for (const record of records) {
            const back = await store.get(record.key)
            if (back?.bytes.size !== record.size || (await sha256Hex(back.bytes)) !== record.key)
                throw new Error(`The package ${record.key} did not read back as written`)
        }
    } catch (error) {
        await rollBack(store, stored.added)
        throw new StoreFailed('The packages did not read back', { cause: error })
    }
    return stored
}
