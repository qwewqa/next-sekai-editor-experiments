import { platform } from '../../../platform'
import { settings } from '../../../settings'
import type { UserAssetRecord } from '../files/store'
import type { AssetType } from '../types'
import { createServerClient } from './client'

/** A server item came back under a new key: the choice follows it, if it still names the old one. */
export const followRedownload = (type: AssetType, oldKey: string, record: UserAssetRecord) => {
    const current = settings.previewAssets[type]
    if (current.source === 'server' && current.key === oldKey)
        settings.previewAssets = {
            ...settings.previewAssets,
            [type]: {
                ...current,
                key: record.key,
                title: record.title,
                author: record.author,
                origin: record.origin,
            },
        }
}

/** The client the editor uses: the platform's fetch, and the interface language. */
export const createLiveServerClient = () =>
    createServerClient({
        fetch: (url, init) => platform.fetchServer(url, init),
        language: () => settings.locale,
    })
