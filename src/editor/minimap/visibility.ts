import { computed } from 'vue'
import type { DrawVisibility } from '../canvas/ordering'
import { entityVisibility } from '../scope'

/**
 * The chart's visibility as far as the strip's content goes. It keeps its identity through the
 * switches of types the strip does not draw (BPM changes, time scales, events), so those redraw
 * nothing; the baselines compare it by identity.
 */
export const contentVisibility = computed<DrawVisibility>((previous) => {
    const next = entityVisibility.value
    return previous?.scope === next.scope &&
        previous.showOtherObjects === next.showOtherObjects &&
        previous.visibilities.note === next.visibilities.note &&
        previous.visibilities.connector === next.visibilities.connector
        ? previous
        : next
})
