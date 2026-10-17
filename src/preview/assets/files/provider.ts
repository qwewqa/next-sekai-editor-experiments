import { buildParticle } from '../../particle'
import { buildSkin } from '../../skin'
import type { LoadedBackground } from '../types'
import { AssetError, type AssetType, type ChoiceProviders, type LoadContext } from '../types'
import { loadEffectFromParts } from './effect'
import { readImageSize } from './image'
import { asImportError } from './importer'
import { checkItem, type CheckedItem, type CheckedParts } from './item'
import { openSourcePackage } from './package'
import type { UserAssetStore } from './store'

// The loader's provider for a stored choice (Part 2, 2.4.2, 2.5.4): the package comes from the
// store, is checked again under the same limits (an older build may have stored it under looser
// ones), and loads. A package that is gone is `missing`; one that fails a check is `corrupt`.

const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError'

/** Every failure of a stored package as the loader's typed error; an abort passes through. */
const toAssetError = (error: unknown, type: AssetType) => {
    if (error instanceof AssetError || isAbort(error)) return error
    const checked = asImportError(error, type)
    return new AssetError(
        'corrupt',
        checked instanceof Error ? checked.message : `The stored ${type} could not be read`,
        { cause: error },
    )
}

const mime = (bytes: Uint8Array) =>
    readImageSize(bytes)?.format === 'jpeg' ? 'image/jpeg' : 'image/png'

const buildBackground = (item: CheckedItem<'background'>): LoadedBackground => {
    const { data, configuration, image, size } = item.parts
    const url = URL.createObjectURL(new Blob([new Uint8Array(image)], { type: mime(image) }))
    return {
        url,
        dispose: () => {
            URL.revokeObjectURL(url)
        },
        title: item.title,
        // Without a ratio of its own, the image's natural one.
        aspectRatio: data.aspectRatio ?? size.width / size.height,
        fit: data.fit,
        color: data.color,
        blur: configuration.blur,
        mask: /^#[0-9a-f]{6}00$/i.test(configuration.mask) ? undefined : configuration.mask,
    }
}

/** Builds what the preview shows from a checked item. */
export const loadChecked = async <T extends AssetType>(
    item: CheckedItem<T>,
    context: LoadContext,
): Promise<unknown> => {
    switch (item.type) {
        case 'skin': {
            const { data, texture } = item.parts as CheckedParts['skin']
            return buildSkin(item.title, data, texture)
        }
        case 'particle': {
            const { data, texture } = item.parts as CheckedParts['particle']
            return buildParticle(item.title, data, texture)
        }
        case 'background':
            return buildBackground(item as CheckedItem<'background'>)
        case 'effect': {
            const effect = await loadEffectFromParts(
                item.title,
                item.parts as CheckedParts['effect'],
                context,
            )
            if (!effect) throw new DOMException('Aborted', 'AbortError')
            return effect
        }
    }
}

export type StoredProviderOptions = {
    store: UserAssetStore
    /** The device's texture limit, read when the first skin or particle loads. */
    maxTextureSide: () => number
}

export const createStoredProviders = ({
    store,
    maxTextureSide,
}: StoredProviderOptions): ChoiceProviders => {
    const provider =
        (type: AssetType) =>
        async (choice: { key: string; name: string }, context: LoadContext): Promise<never> => {
            let stored
            try {
                stored = await store.get(choice.key)
            } catch (error) {
                throw new AssetError('unavailable', 'The store did not answer', { cause: error })
            }
            if (!stored) throw new AssetError('missing', `The stored ${type} is gone`)
            if (context.signal.aborted) throw new DOMException('Aborted', 'AbortError')
            try {
                const pkg = await openSourcePackage(stored.bytes)
                const checked = await checkItem(pkg, type, choice.name, {
                    mode: 'load',
                    maxTextureSide: maxTextureSide(),
                    signal: context.signal,
                })
                return (await loadChecked(checked, context)) as never
            } catch (error) {
                throw toAssetError(error, type)
            }
        }
    return {
        skin: provider('skin'),
        particle: provider('particle'),
        background: provider('background'),
        effect: provider('effect'),
    } as ChoiceProviders
}
