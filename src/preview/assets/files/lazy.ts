import { assetTypes } from '../choice'
import { AssetError, type AssetType, type ChoiceProviders } from '../types'
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
    // A chunk that failed to load (offline, or gone after a deploy) is tried again next time.
    const load = () =>
        (providers ??= importProvider().then(
            ({ createStoredProviders }) =>
                createStoredProviders({ store: workerStore, maxTextureSide }),
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
