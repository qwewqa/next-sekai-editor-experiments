import { computed, shallowRef } from 'vue'
import { bpms } from '../history/bpms'
import { settings } from '../settings'
import type { BpmIntegral, GridBpm } from '../state/integrals/bpms'
import { GLOBAL_GRID, toBeatGrid } from '../state/integrals/grid'

// Measure and Both show bars, so beats snap from them; Beat keeps the global grid.
const isBarGrid = computed(() => settings.beatDisplay !== 'beat')

export const gridOf = (bpms: GridBpm[]) => (isBarGrid.value ? toBeatGrid(bpms) : GLOBAL_GRID)

/** A scaling drag's tempo and bars at its press: its draft moves BPM changes under it. */
export const dragBpms = shallowRef<BpmIntegral[]>()

/** The committed chart's bar grid, whatever the display. */
export const committedBarGrid = computed(() => toBeatGrid(bpms.value))

/** The grid of the committed chart, which pointers snap to; BPM change moves keep it until the drop. */
export const committedGrid = computed(() => gridOf(bpms.value))
