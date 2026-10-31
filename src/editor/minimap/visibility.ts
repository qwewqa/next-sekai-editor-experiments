import { computed } from 'vue'
import type { DrawVisibility } from '../canvas/ordering'
import { entityVisibility } from '../scope'

/** Show Other Objects as far as notes and bodies go: it changes them only while one is hidden. */
const othersShown = ({ visibilities, showOtherObjects }: DrawVisibility) =>
    showOtherObjects && !(visibilities.note && visibilities.connector)

/**
 * The chart's visibility as far as the strip's content goes. It keeps its identity through
 * changes that cannot change a note or a body (the switches of the other types, and Show Other
 * Objects while notes and bodies are shown), so those redraw nothing; the baselines compare it by
 * identity.
 */
export const contentVisibility = computed<DrawVisibility>((previous) => {
    const next = entityVisibility.value
    return previous?.scope === next.scope &&
        previous.visibilities.note === next.visibilities.note &&
        previous.visibilities.connector === next.visibilities.connector &&
        othersShown(previous) === othersShown(next)
        ? previous
        : next
})
