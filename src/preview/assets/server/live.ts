import { platform } from '../../../platform'
import { settings } from '../../../settings'
import type { UserAssetRecord } from '../files/store'
import type { AssetType } from '../types'
import { createServerClient, type ServerClient } from './client'
import { followedChoices } from './redownload'

/** A server item came back under a new key: the choice follows it, if it still names the old one. */
export const followRedownload = (type: AssetType, oldKey: string, record: UserAssetRecord) => {
    const next = followedChoices(settings.previewAssets, type, oldKey, record)
    if (next) settings.previewAssets = next
}

let live: ServerClient | undefined

/**
 * The client the editor uses: the platform's fetch, and the interface language. One for the
 * dialog and the loader together, so at most 4 requests are open in all.
 */
export const liveServerClient = () =>
    (live ??= createServerClient({
        fetch: (url, init) => platform.fetchServer(url, init),
        language: () => settings.locale,
    }))
