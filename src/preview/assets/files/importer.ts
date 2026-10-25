import { toHex } from '../../../local/hash'
import type { UserAssetRecord } from '../../../local/userAssets'
import type { AssetType, LoadContext } from '../types'
import type { DecodeImage } from './decodeImage'
import { loadEffectFromParts } from './effect'
import { AssetImportError, asImportError } from './errors'
import { checkItem, type CheckedItem } from './item'
import { LIMITS } from './limits'
import type { SourcePackage } from './package'
import { repackItem } from './repack'

// Importing one item: check it all, repack it into a standard single-item
// package and name it by its sha256. Nothing is stored here; the caller puts the record.

export type ImportContext = {
    /** What the device's textures may be, at most 4096. */
    maxTextureSide: number
    decodeAudio: LoadContext['decodeAudio']
    decodeImage: DecodeImage
    signal: AbortSignal
    /** The file name, or the server's address */
    origin: string
    now: () => number
}

const throwIfAborted = (signal: AbortSignal) => {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
}

/** Checks everything about an item the way a stored package is checked again at load. */
export const checkWholeItem = async (
    pkg: SourcePackage,
    type: AssetType,
    name: string,
    context: ImportContext,
): Promise<CheckedItem> => {
    throwIfAborted(context.signal)
    const checked = await checkItem(pkg, type, name, {
        mode: 'import',
        maxTextureSide: context.maxTextureSide,
        signal: context.signal,
        decodeImage: context.decodeImage,
    })
    // The images decoded; a clip is only known good once it decodes too.
    if (checked.type === 'effect') {
        await loadEffectFromParts(checked.title, checked.parts as never, {
            signal: context.signal,
            decodeAudio: context.decodeAudio,
        })
    }
    throwIfAborted(context.signal)
    return checked
}

export const sha256Hex = async (blob: Blob) =>
    toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())))

/** Checks, repacks and names one item; resolves to the record to store. */
export const importItem = async (
    pkg: SourcePackage,
    type: AssetType,
    name: string,
    context: ImportContext,
): Promise<UserAssetRecord> => {
    let checked: CheckedItem
    try {
        checked = await checkWholeItem(pkg, type, name, context)
    } catch (error) {
        throw asImportError(error, type)
    }

    const bytes = await repackItem(checked)
    if (bytes.size > LIMITS.package)
        throw new AssetImportError('packageTooLarge', { type, limit: LIMITS.package })
    throwIfAborted(context.signal)

    const key = await sha256Hex(bytes)
    const time = context.now()
    return {
        key,
        type,
        name,
        title: checked.title,
        author: checked.author,
        origin: context.origin,
        bytes,
        size: bytes.size,
        addedAt: time,
        lastUsedAt: time,
    }
}
