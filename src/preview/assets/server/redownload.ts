import type { DecodeImage } from '../files/decodeImage'
import { AssetImportError } from '../files/errors'
import { importItem } from '../files/importer'
import type { UserAssetRecord, UserAssetStore } from '../files/store'
import { storeRecords } from '../files/storeRecords'
import { parseServerUrl } from '../serverUrl'
import { AssetError, type AssetChoice, type AssetType, type LoadContext } from '../types'
import { ServerError, type ServerClient } from './client'
import { createServerSource } from './source'

// A server item whose package left storage is downloaded again when the preview loads, in the apps: a background request to the server the user chose earlier, with no prompt.
// A failure is the loader's fallback, whose line says why: offline, or not downloaded again.

/**
 * The choices with a type's server choice moved to the record's new key, or undefined when the
 * choice no longer names the old key (the user chose something else meanwhile).
 */
export const followedChoices = <T extends Record<AssetType, AssetChoice>>(
    choices: T,
    type: AssetType,
    oldKey: string,
    record: UserAssetRecord,
): T | undefined => {
    const current = choices[type]
    if (current.source !== 'server' || current.key !== oldKey) return
    return {
        ...choices,
        [type]: {
            ...current,
            key: record.key,
            title: record.title,
            author: record.author,
            origin: record.origin,
        },
    }
}

export type RedownloadOptions = {
    client: ServerClient
    store: UserAssetStore
    maxTextureSide: () => number
    decodeImage: DecodeImage
    /** The item came back under another key (the server changed it): the choice follows. */
    replace: (type: AssetType, oldKey: string, record: UserAssetRecord) => void
    allowHttp?: boolean
    now?: () => number
}

export const createRedownload =
    ({
        client,
        store,
        maxTextureSide,
        decodeImage,
        replace,
        allowHttp,
        now = Date.now,
    }: RedownloadOptions) =>
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
                    decodeImage,
                    signal: context.signal,
                    origin: info.address,
                    now,
                },
            )
        } catch (error) {
            if (error instanceof ServerError)
                throw new AssetError(
                    error.code === 'offline' ? 'offline' : 'unavailable',
                    error.message,
                    { cause: error },
                )
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
        // Stored and read back, as Use stores.
        try {
            await storeRecords(store, [record])
        } catch (error) {
            // It still loads this time; the next load downloads it again.
            console.error('Could not store the downloaded preview asset:', error)
            return record
        }
        if (record.key !== choice.key) replace(type, choice.key, record)
        return record
    }
