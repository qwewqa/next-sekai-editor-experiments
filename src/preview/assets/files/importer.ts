import { toHex } from '../../../local/hash'
import type { UserAssetRecord } from '../../../local/userAssets'
import { ZipError } from '../../../zip'
import { AssetError, type AssetType, type LoadContext } from '../types'
import { loadEffectFromParts } from './effect'
import { AssetImportError } from './errors'
import { checkItem, type CheckedItem } from './item'
import { LIMITS } from './limits'
import type { SourcePackage } from './package'
import { repackItem } from './repack'

// Importing one item (Part 2, 2.5.2): check it all, repack it into a standard single-item
// package and name it by its sha256. Nothing is stored here; the caller puts the record.

export type ImportContext = {
    /** What the device's textures may be, at most 4096. */
    maxTextureSide: number
    decodeAudio: LoadContext['decodeAudio']
    signal: AbortSignal
    /** The file name, or the server's address */
    origin: string
    now: () => number
}

const throwIfAborted = (signal: AbortSignal) => {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
}

/** Any failure of reading a package, as the one error the dialog words. */
export const asImportError = (error: unknown, type?: AssetType): unknown => {
    if (error instanceof AssetImportError) return error
    if (error instanceof ZipError)
        return new AssetImportError('damaged', { type }, { cause: error })
    return error
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
    })
    // The images' headers passed; a clip is only known good once it decodes.
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
        if (error instanceof AssetError) throw new AssetImportError('noPerfect', { type })
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
