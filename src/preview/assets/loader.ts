import { release } from './release'
import {
    AssetError,
    type AssetChoice,
    type AssetDefaults,
    type AssetErrorCode,
    type AssetResult,
    type AssetStatus,
    type AssetType,
    type ChoiceProviders,
    type DefaultProvider,
    type LoadContext,
    type Loaded,
} from './types'

export const reasonOf = (error: unknown): AssetErrorCode =>
    error instanceof AssetError ? error.code : 'corrupt'

/**
 * Loads one asset by the fallback chain: the chosen source, then Default, then
 * Built-in. Resolves undefined when aborted; rejects with Default's failure when the chain is exhausted.
 */
export const createAssetLoader = (options: {
    defaults: AssetDefaults
    /** The Built-in set: the Built-in choice, and the last resort when Default fails. */
    builtin?: AssetDefaults
    providers?: ChoiceProviders
}) => {
    const { defaults, builtin, providers = {} } = options

    const load = async <T extends AssetType>(
        type: T,
        choice: AssetChoice,
        context: LoadContext,
    ): Promise<AssetResult<T> | undefined> => {
        // A function, so TypeScript does not keep an earlier check's narrowing across awaits.
        const isAborted = () => context.signal.aborted
        const builtinProvider = builtin?.[type] as DefaultProvider<T> | undefined
        const defaultProvider = defaults[type] as DefaultProvider<T>
        // In the apps Default is Built-in, which needs no second try.
        const hasLastResort = builtinProvider !== undefined && builtinProvider !== defaultProvider
        let reason: AssetErrorCode | undefined

        if (choice.source === 'builtin' && builtinProvider) {
            try {
                const value = await builtinProvider(context)
                if (isAborted()) {
                    release(type, value)
                    return
                }
                if (value !== undefined) return { value, status: { active: 'builtin' } }
                reason = 'missing'
            } catch (error) {
                if (isAborted()) return
                console.error(`Failed to load the built-in ${type}:`, error)
                reason = reasonOf(error)
            }
        } else if (choice.source !== 'default') {
            try {
                const provider = providers[type]
                if (!provider) throw new AssetError('unavailable', `No ${type} provider`)
                // A provider type is keyed by T, which the mapped type cannot express here.
                const value = await (
                    provider as (choice: AssetChoice, context: LoadContext) => Promise<Loaded[T]>
                )(choice, context)
                if (isAborted()) {
                    release(type, value)
                    return
                }
                return { value, status: { active: 'chosen' } }
            } catch (error) {
                if (isAborted()) return
                console.error(`Failed to load the chosen ${type}:`, error)
                reason = reasonOf(error)
            }
        }

        let failure: unknown
        try {
            const value = await defaultProvider(context)
            if (isAborted()) {
                release(type, value)
                return
            }
            if (value !== undefined) return { value, status: { active: 'default', reason } }
            failure = new AssetError('missing', `The default ${type} is missing`)
        } catch (error) {
            if (isAborted()) return
            failure = error
        }

        if (hasLastResort && choice.source !== 'builtin') {
            // A missing file is an ordinary configuration, as on a fork without the particle.
            if (reasonOf(failure) !== 'missing')
                console.error(`Failed to load the default ${type}:`, failure)
            try {
                const value = await builtinProvider(context)
                if (isAborted()) {
                    release(type, value)
                    return
                }
                if (value !== undefined) {
                    const status: AssetStatus = {
                        active: 'builtin',
                        reason: reason ?? reasonOf(failure),
                    }
                    return { value, status }
                }
            } catch (error) {
                if (isAborted()) return
                console.error(`Failed to load the built-in ${type}:`, error)
            }
        }
        throw failure
    }

    return { load }
}

export type AssetLoader = ReturnType<typeof createAssetLoader>
