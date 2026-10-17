import { buildParticle } from '../../particle'
import { buildSkin } from '../../skin'
import {
    AssetError,
    type AssetType,
    type ChoiceProviders,
    type LoadContext,
    type LoadedBackground,
} from '../types'
import { decodeImageToCheck, type DecodeImage } from './decodeImage'
import { loadEffectFromParts } from './effect'
import { asImportError } from './errors'
import { readImageSize } from './image'
import { checkItem, type CheckedItem, type CheckedParts } from './item'
import { openSourcePackage } from './package'
import type { UserAssetRecord, UserAssetStore } from './store'

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
    /** Fetches a server item again when its package is no longer stored (Part 2, 2.5.4). */
    redownload?: (
        type: AssetType,
        choice: { key: string; name: string; origin: string },
        context: LoadContext,
    ) => Promise<UserAssetRecord>
    /** Decodes a background before it shows; a skin's or particle's texture decodes anyway. */
    decodeImage?: DecodeImage
}

export const createStoredProviders = ({
    store,
    maxTextureSide,
    redownload,
    decodeImage = decodeImageToCheck,
}: StoredProviderOptions): ChoiceProviders => {
    const provider =
        (type: AssetType) =>
        async (
            choice: { source: string; key: string; name: string; origin: string },
            context: LoadContext,
        ): Promise<never> => {
            let stored
            try {
                stored = await store.get(choice.key)
            } catch (error) {
                // A server item can still be downloaded when the store cannot be read.
                if (choice.source !== 'server' || !redownload)
                    throw new AssetError('unavailable', 'The store did not answer', {
                        cause: error,
                    })
            }
            if (!stored && choice.source === 'server' && redownload) {
                try {
                    stored = await redownload(type, choice, context)
                } catch (error) {
                    throw toAssetError(error, type)
                }
            }
            if (!stored) throw new AssetError('missing', `The stored ${type} is gone`)
            if (context.signal.aborted) throw new DOMException('Aborted', 'AbortError')
            try {
                const pkg = await openSourcePackage(stored.bytes)
                const checked = await checkItem(pkg, type, choice.name, {
                    mode: 'load',
                    maxTextureSide: maxTextureSide(),
                    signal: context.signal,
                    // A background that will not decode falls back, rather than show only its colour.
                    ...(type === 'background' ? { decodeImage } : {}),
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
