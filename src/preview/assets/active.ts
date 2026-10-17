import { computed } from 'vue'
import { settings } from '../../settings'
import { assetTypes, choiceKey } from './choice'
import { assetSession, isAssetSafeModeActive } from './index'
import { fallbackOf, undismissed, withDismissed } from './notices'
import type { AssetChoice, AssetType } from './types'

// A reason belongs to the choice it was found for, so it is not kept while a newer choice loads.
const isCurrent = (type: AssetType, choice: AssetChoice | undefined) =>
    isAssetSafeModeActive ||
    (!!choice && choiceKey(choice) === choiceKey(settings.previewAssets[type]))

/** Every type that is not using its choice, with the reason; the dialog shows all of them. */
export const fallbacks = computed(() =>
    assetTypes.flatMap((type) => {
        const slot = assetSession.slots[type].value
        return isCurrent(type, slot.choice) ? (fallbackOf(type, slot) ?? []) : []
    }),
)

/** The fallbacks the Preview panel's line shows; safe mode shows none. */
export const panelFallbacks = computed(() =>
    isAssetSafeModeActive ? [] : undismissed(fallbacks.value, settings.dismissedAssetNotices),
)

/** Hides a fallback in the panel for good; the dialog keeps its row. */
export const dismissFallback = (key: string) => {
    settings.dismissedAssetNotices = withDismissed(settings.dismissedAssetNotices, key)
}
