import {
    AssetError,
    type AssetChoice,
    type AssetDefaults,
    type AssetErrorCode,
    type AssetResult,
    type AssetType,
    type ChoiceProviders,
    type DefaultProvider,
    type LoadContext,
    type Loaded,
} from './types'

const reasonOf = (error: unknown) => (error instanceof AssetError ? error.code : 'corrupt')

/**
 * Loads one asset by the fallback chain: the chosen source, then Default.
 * Resolves undefined when aborted; rejects with the last failure when the chain is exhausted.
 */
export const createAssetLoader = (options: {
    defaults: AssetDefaults
    providers?: ChoiceProviders
}) => {
    const { defaults, providers = {} } = options

    const load = async <T extends AssetType>(
        type: T,
        choice: AssetChoice,
        context: LoadContext,
    ): Promise<AssetResult<T> | undefined> => {
        let reason: AssetErrorCode | undefined

        if (choice.source !== 'default') {
            try {
                const provider = providers[type]
                if (!provider) throw new AssetError('unavailable', `No ${type} provider`)
                // A provider type is keyed by T, which the mapped type cannot express here.
                const value = await (
                    provider as (choice: AssetChoice, context: LoadContext) => Promise<Loaded[T]>
                )(choice, context)
                if (context.signal.aborted) return
                return { value, status: { active: 'chosen' } }
            } catch (error) {
                if (context.signal.aborted) return
                console.error(`Failed to load the chosen ${type}:`, error)
                reason = reasonOf(error)
            }
        }

        const provideDefault = defaults[type] as DefaultProvider<T>
        const value = await provideDefault(context)
        if (context.signal.aborted) return
        if (value === undefined) throw new AssetError('missing', `The default ${type} is missing`)
        return { value, status: { active: 'default', reason } }
    }

    return { load }
}

export type AssetLoader = ReturnType<typeof createAssetLoader>
