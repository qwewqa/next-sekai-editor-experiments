import { assetTypes } from '../choice'
import type { AssetType, ChoiceProviders } from '../types'
import { workerStore } from './store'
import { maxTextureSide } from './textureLimit'

/**
 * The providers of stored choices, loaded when the first one is needed: the ZIP reader and the
 * schemas stay out of the main bundle for the many pages that use Default or Built-in.
 */
export const lazyStoredProviders = (): ChoiceProviders => {
    let providers: Promise<ChoiceProviders> | undefined
    const load = () =>
        (providers ??= import('./provider').then(({ createStoredProviders }) =>
            createStoredProviders({ store: workerStore, maxTextureSide }),
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
