import { platform } from '../../../platform'
import { assetTypes } from '../choice'
import { AssetError, type AssetType, type ChoiceProviders } from '../types'
import { decodeImageToCheck } from './decodeImage'
import type { StoredProviderOptions } from './provider'
import { workerStore } from './store'
import { maxTextureSide } from './textureLimit'

/**
 * The providers of stored choices, loaded when the first one is needed: the ZIP reader and the
 * schemas stay out of the main bundle for the many pages that use Default or Built-in.
 */
export const lazyStoredProviders = (
    importProvider: () => Promise<typeof import('./provider')> = () => import('./provider'),
): ChoiceProviders => {
    let providers: Promise<ChoiceProviders> | undefined
    // The server code loads on the first server choice whose package is gone. The web fetches
    // no servers: there such a choice falls back.
    let redownload: Promise<NonNullable<StoredProviderOptions['redownload']>> | undefined
    const redownloader = () =>
        (redownload ??= Promise.all([
            import('../server/redownload'),
            import('../server/live'),
        ]).then(
            ([{ createRedownload }, { liveServerClient, followRedownload }]) =>
                createRedownload({
                    client: liveServerClient(),
                    store: workerStore,
                    maxTextureSide,
                    decodeImage: decodeImageToCheck,
                    replace: followRedownload,
                }),
            (error: unknown) => {
                redownload = undefined
                throw new AssetError('unavailable', 'The server reader did not load', {
                    cause: error,
                })
            },
        ))
    // A chunk that failed to load (offline, or gone after a deploy) is tried again next time.
    const load = () =>
        (providers ??= importProvider().then(
            ({ createStoredProviders }) =>
                createStoredProviders({
                    store: workerStore,
                    maxTextureSide,
                    redownload: async (type, choice, context) => {
                        if (!platform.capabilities.serverFetch)
                            throw new AssetError('missing', 'This build fetches no servers')
                        return (await redownloader())(type, choice, context)
                    },
                }),
            (error: unknown) => {
                providers = undefined
                throw new AssetError('unavailable', 'The stored-item reader did not load', {
                    cause: error,
                })
            },
        ))
    return Object.fromEntries(
        assetTypes.map((type: AssetType) => [
            type,
            async (choice: never, context: never) =>
                ((await load())[type] as (choice: never, context: never) => Promise<unknown>)(
                    choice,
                    context,
                ),
        ]),
    )
}
