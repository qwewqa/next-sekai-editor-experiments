import { ZipError } from '../../../zip/error'
import type { AssetType } from '../types'

/** The part of an item a message names. */
export type ImportPart =
    'list' | 'details' | 'data' | 'texture' | 'image' | 'configuration' | 'audio' | 'thumbnail'

export type ImportErrorCode =
    | 'damaged'
    | 'zip64'
    | 'fileTooLarge'
    | 'tooManyEntries'
    | 'badName'
    | 'ratio'
    | 'tooBig'
    | 'unreadable'
    | 'missing'
    | 'notImage'
    | 'imageSize'
    | 'checksum'
    | 'spriteOutside'
    | 'tooManySprites'
    | 'tooManyEffects'
    | 'particleCount'
    | 'noPerfect'
    | 'audioLength'
    | 'packageTooLarge'
    | 'storeFailed'

export type ImportDetail = {
    type?: AssetType
    part?: ImportPart
    /** An image's size and its limit, a cap, or an effect's name */
    width?: number
    height?: number
    limit?: number
    name?: string
}

/**
 * A package that is refused, at import or at load. The dialog turns it into a plain message
 * (`importText.ts`); the loader turns it into a fallback.
 */
export class AssetImportError extends Error {
    constructor(
        readonly code: ImportErrorCode,
        readonly detail: ImportDetail = {},
        options?: ErrorOptions,
    ) {
        super(
            `${code}${detail.type ? ` (${detail.type}${detail.part ? ` ${detail.part}` : ''})` : ''}`,
            options,
        )
        this.name = 'AssetImportError'
    }
}

/** Any failure of reading a package, as the one error the dialog words. */
export const asImportError = (error: unknown, type?: AssetType): unknown => {
    if (error instanceof AssetImportError) return error
    if (error instanceof ZipError)
        return new AssetImportError('damaged', { type }, { cause: error })
    return error
}
