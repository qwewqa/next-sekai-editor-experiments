import { interpolateRaw } from '../../../utils/interpolate'
import type { AssetType } from '../types'
import type { AssetImportError, ImportErrorCode, ImportPart } from './errors'
import { LIMITS } from './limits'

// The words of a refused package (Part 2, 2.5.5). Kept free of the i18n module so tests can pass
// the English strings in.

export type ImportStrings = {
    import: Record<ImportErrorCode, string>
    part: Record<ImportPart, string>
    noun: Record<AssetType, string>
}

/** A size in the units a limit is written in. */
const size = (bytes: number, number: (value: number) => string) => {
    const mebi = 1024 * 1024
    return bytes >= 1024 * mebi
        ? `${number(bytes / (1024 * mebi))} GiB`
        : `${number(bytes / mebi)} MiB`
}

/** The plain message for a package that is refused, naming the problem. */
export const formatImportMessage = (
    error: AssetImportError,
    strings: ImportStrings,
    number: (value: number) => string,
): string => {
    const { import: text, part } = strings
    const { code, detail } = error
    const noun = detail.type ? strings.noun[detail.type] : ''
    const partNoun = detail.part ? part[detail.part] : ''
    const limit = detail.limit ?? 0

    switch (code) {
        case 'damaged':
        case 'zip64':
        case 'badName':
        case 'storeFailed':
            return text[code]
        case 'fileTooLarge':
            return interpolateRaw(text.fileTooLarge, size(limit, number))
        case 'tooManyEntries':
            return interpolateRaw(text.tooManyEntries, number(limit))
        case 'ratio':
            return interpolateRaw(text.ratio, noun, partNoun, String(LIMITS.ratio))
        case 'tooBig':
            return interpolateRaw(
                text.tooBig,
                noun,
                partNoun,
                size(limit || LIMITS.package, number),
            )
        case 'unreadable':
        case 'missing':
        case 'notImage':
        case 'checksum':
            return interpolateRaw(text[code], noun, partNoun)
        case 'imageSize':
            return interpolateRaw(
                text.imageSize,
                noun,
                partNoun,
                String(detail.width ?? 0),
                String(detail.height ?? 0),
                String(limit),
            )
        case 'spriteOutside':
        case 'noPerfect':
            return interpolateRaw(text[code], noun)
        case 'tooManySprites':
        case 'tooManyEffects':
        case 'tooManyParticles':
        case 'tooManyGroups':
        case 'audioLength':
            return interpolateRaw(text[code], noun, number(limit))
        case 'particleCount':
        case 'effectGroups':
            return interpolateRaw(text[code], noun, detail.name ?? '', number(limit))
        case 'packageTooLarge':
            return interpolateRaw(text.packageTooLarge, size(limit, number))
    }
}
