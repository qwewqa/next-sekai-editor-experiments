import { AssetImportError } from '../files/errors'
import { importItem } from '../files/importer'
import type { UserAssetRecord, UserAssetStore } from '../files/store'
import { parseServerUrl } from '../serverUrl'
import { AssetError, type AssetType, type LoadContext } from '../types'
import { ServerError, type ServerClient } from './client'
import { createServerSource } from './source'

// A server item whose package left storage is downloaded again when the preview loads (Part 2,
// 2.5.4): a background request to the server the user chose earlier, with no prompt. A failure is
// the loader's fallback, whose line says the item could not be downloaded again.

export type RedownloadOptions = {
    client: ServerClient
    store: UserAssetStore
    maxTextureSide: () => number
    /** The item came back under another key (the server changed it): the choice follows. */
    replace: (type: AssetType, oldKey: string, record: UserAssetRecord) => void
    allowHttp?: boolean
    now?: () => number
}

export const createRedownload =
    ({ client, store, maxTextureSide, replace, allowHttp, now = Date.now }: RedownloadOptions) =>
    async (
        type: AssetType,
        choice: { key: string; name: string; origin: string },
        context: LoadContext,
    ): Promise<UserAssetRecord> => {
        let base: string
        try {
            base = parseServerUrl(choice.origin, { allowHttp }).base
        } catch (error) {
            throw new AssetError('missing', 'The server address is not usable', { cause: error })
        }
        let record: UserAssetRecord
        try {
            const info = await client.connect(base, context.signal)
            record = await importItem(
                createServerSource(client, info.address, context.signal),
                type,
                choice.name,
                {
                    maxTextureSide: maxTextureSide(),
                    decodeAudio: context.decodeAudio,
                    signal: context.signal,
                    origin: info.address,
                    now,
                },
            )
        } catch (error) {
            if (error instanceof ServerError)
                throw new AssetError('unavailable', error.message, { cause: error })
            // An item the server no longer has is not a bad item.
            if (
                error instanceof AssetImportError &&
                error.code === 'missing' &&
                error.detail.part === 'details'
            )
                throw new AssetError('missing', 'The server no longer has the item', {
                    cause: error,
                })
            throw error
        }
        try {
            await store.put(record)
        } catch (error) {
            // It still loads this time; the next load downloads it again.
            console.error('Could not store the downloaded preview asset:', error)
            return record
        }
        if (record.key !== choice.key) replace(type, choice.key, record)
        return record
    }
