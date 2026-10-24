import {
    getUserAsset,
    listUserAssets,
    putUserAsset,
    putUserAssets,
    removeUserAsset,
    touchUserAsset,
    USER_ASSETS,
    type UserAssetRecord,
} from '../userAssets'
import type { WorkerContext } from './handlers'

// The storage worker's methods for stored preview assets. Blobs cross the
// channel as references, and no handler reads one, so no transaction waits on a Blob.

export const userAssetHandlers = (context: WorkerContext) => ({
    // A package that does not fit is the dialog's to report: storing is not paused for it, so the
    // history goes on being stored (as for media whose read-back failed).
    userAssetPut: (record: UserAssetRecord) =>
        context.core.write([USER_ASSETS], (tx) => putUserAsset(tx, record), {
            durability: 'strict',
            pauseOnFailure: false,
        }),
    userAssetPutMany: (records: UserAssetRecord[]) =>
        context.core.write([USER_ASSETS], (tx) => putUserAssets(tx, records), {
            durability: 'strict',
            pauseOnFailure: false,
        }),
    userAssetList: () => context.core.read([USER_ASSETS], listUserAssets),
    userAssetGet: (key: string) => context.core.read([USER_ASSETS], (tx) => getUserAsset(tx, key)),
    userAssetTouch: ({ key, time }: { key: string; time: number }) =>
        context.core.write([USER_ASSETS], (tx) => touchUserAsset(tx, key, time)),
    userAssetRemove: (key: string) =>
        context.core.write([USER_ASSETS], (tx) => removeUserAsset(tx, key), {
            durability: 'strict',
        }),
})
