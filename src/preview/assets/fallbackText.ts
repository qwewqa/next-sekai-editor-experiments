import { i18n } from '../../i18n'
import { platform } from '../../platform'
import { interpolateRaw } from '../../utils/interpolate'
import type { FallbackState } from './notices'
import { displayOrigin } from './serverUrl'

const strings = () => i18n.value.commands.previewAssets

/** The type as the lowercase noun inside a sentence ("skin", "sound effects"). */
export const typeNoun = (type: FallbackState['type']) => strings().noun[type]

/** The type as a tab label ("Skin", "Sound Effects"). */
export const typeLabel = (type: FallbackState['type']) => strings()[type]

/**
 * What the Default row of a type is called. On the web it is a Next SEKAI package or, for the
 * background, "Default"; in the apps Default is Built-in.
 */
export const defaultName = (type: FallbackState['type']) => {
    if (!platform.capabilities.defaultAssets) return strings().default
    switch (type) {
        case 'skin':
        case 'effect':
            return strings().nextSekai01
        case 'particle':
            return strings().nextSekai
        case 'background':
            return strings().default
    }
}

// Default or Built-in by name; a stored item by its title, in the locale's own quotes.
const usingLabel = (fallback: FallbackState) =>
    fallback.using === 'default'
        ? defaultName(fallback.type)
        : fallback.using === 'builtin'
          ? strings().builtin
          : fallback.usingTitle

/** The reason sentence, the same in the panel's line and the dialog's row. */
export const reasonText = (fallback: FallbackState) => {
    const { reason } = strings()
    const noun = typeNoun(fallback.type)
    switch (fallback.reason) {
        case 'fileGone':
            // The native apps will need the on-this-device wording here, chosen by the `browserStorage`
            // capability.
            return interpolateRaw(reason.fileGone, noun)
        case 'storageUnavailable':
            return interpolateRaw(reason.storageUnavailable, noun)
        case 'serverFailed':
            return interpolateRaw(reason.serverFailed, noun, displayOrigin(fallback.origin))
        case 'offline':
            return strings().offline
        case 'invalid':
            return interpolateRaw(reason.invalid, noun)
        case 'bundledFailed':
            return interpolateRaw(reason.failed, strings().nextSekai02)
        case 'defaultFailed':
            return interpolateRaw(reason.failed, defaultName(fallback.type))
        case 'builtinFailed':
            return reason.builtinFailed
    }
}

/** "Using Next SEKAI 01. The skin file is no longer stored in this browser." under the chosen row. */
export const rowText = (fallback: FallbackState) =>
    interpolateRaw(
        fallback.using === 'stored' ? strings().fallback.rowStored : strings().fallback.row,
        usingLabel(fallback),
        reasonText(fallback),
    )

/** "Skin: using Next SEKAI 01. …" in the Preview panel. */
export const panelText = (fallback: FallbackState) =>
    interpolateRaw(
        fallback.using === 'stored' ? strings().fallback.panelStored : strings().fallback.panel,
        typeLabel(fallback.type),
        usingLabel(fallback),
        reasonText(fallback),
    )
