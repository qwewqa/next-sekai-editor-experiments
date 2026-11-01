import { computed, ref } from 'vue'
import { settings } from '../settings'

const touchScreenQuery = matchMedia('(any-pointer: coarse)')
/** Whether any pointer is a touch screen. */
export const hasTouchScreen = ref(touchScreenQuery.matches)
touchScreenQuery.addEventListener('change', () => {
    hasTouchScreen.value = touchScreenQuery.matches
})

/** The quick scroll zone's width in pane pixels, at most half the pane. */
export const quickScrollWidth = (paneWidth: number) =>
    Math.min(settings.touchQuickScrollWidth, paneWidth / 2)

/** Whether a press at `x` is in the zone on the pane's `side`. A press on its inner edge is not. */
export const inQuickScrollZone = (
    x: number,
    bounds: { x: number; w: number },
    side: 'left' | 'right',
) => {
    const width = quickScrollWidth(bounds.w)
    return side === 'left' ? x - bounds.x < width : x - bounds.x > bounds.w - width
}

export const isQuickScrollZoneShown = computed(
    () =>
        settings.touchQuickScrollWidth > 0 &&
        (settings.touchQuickScrollShow === 'on' ||
            (settings.touchQuickScrollShow === 'touch' && hasTouchScreen.value)),
)
