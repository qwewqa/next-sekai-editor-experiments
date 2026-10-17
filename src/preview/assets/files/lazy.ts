import { settings } from '../../../settings'
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
        (providers ??= Promise.all([
            import('./provider'),
            import('../server/redownload'),
            import('../server/live'),
        ]).then(([{ createStoredProviders }, { createRedownload }, { createLiveServerClient }]) =>
            createStoredProviders({
                store: workerStore,
                maxTextureSide,
                redownload: createRedownload({
                    client: createLiveServerClient(),
                    store: workerStore,
                    maxTextureSide,
                    replace: (type, oldKey, record) => {
                        // Only if the choice still names the item that was downloaded again.
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
                    },
                }),
            }),
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
