import { i18n } from '../../i18n'
import { interpolateRaw } from '../../utils/interpolate'
import type { FallbackState } from './notices'

const strings = () => i18n.value.commands.previewAssets

/** The type as the lowercase noun inside a sentence ("skin", "sound effects"). */
export const typeNoun = (type: FallbackState['type']) => strings().noun[type]

/** The type as a tab label ("Skin", "Sound Effects"). */
export const typeLabel = (type: FallbackState['type']) => strings()[type]

const usingLabel = (fallback: FallbackState) =>
    fallback.using === 'default'
        ? strings().default
        : fallback.using === 'builtin'
          ? strings().builtin
          : `"${fallback.usingTitle}"`

/** The reason sentence, the same in the panel's line and the dialog's row. */
export const reasonText = (fallback: FallbackState) => {
    const { reason } = strings()
    const noun = typeNoun(fallback.type)
    switch (fallback.reason) {
        case 'fileGone':
            // Stage 2 adds the on-this-device wording, chosen by the browserStorage capability.
            return interpolateRaw(reason.fileGone, noun)
        case 'storageUnavailable':
            return interpolateRaw(reason.storageUnavailable, noun)
        case 'serverFailed':
            return interpolateRaw(reason.serverFailed, noun, fallback.origin)
        case 'invalid':
            return interpolateRaw(reason.invalid, noun)
        case 'defaultFailed':
            return reason.defaultFailed
        case 'builtinFailed':
            return reason.builtinFailed
    }
}

/** "Using Default. The skin file is no longer stored in this browser." under the chosen row. */
export const rowText = (fallback: FallbackState) =>
    interpolateRaw(strings().fallback.row, usingLabel(fallback), reasonText(fallback))

/** "Skin: using Default. …" in the Preview panel. */
export const panelText = (fallback: FallbackState) =>
    interpolateRaw(
        strings().fallback.panel,
        typeLabel(fallback.type),
        usingLabel(fallback),
        reasonText(fallback),
    )
