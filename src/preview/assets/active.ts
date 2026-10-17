import { computed } from 'vue'
import { settings } from '../../settings'
import { assetTypes } from './choice'
import { assetSession } from './index'
import { fallbackOf, undismissed, withDismissed } from './notices'

/** Every type that is not using its choice, with the reason; the dialog shows all of them. */
export const fallbacks = computed(() =>
    assetTypes.flatMap((type) => fallbackOf(type, assetSession.slots[type].value) ?? []),
)

/** The fallbacks the Preview panel's line shows. */
export const panelFallbacks = computed(() =>
    undismissed(fallbacks.value, settings.dismissedAssetNotices),
)

/** Hides a fallback in the panel for good; the dialog keeps its row. */
export const dismissFallback = (key: string) => {
    settings.dismissedAssetNotices = withDismissed(settings.dismissedAssetNotices, key)
}
