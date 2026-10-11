import { computed, shallowRef } from 'vue'
import { state } from '../history'
import { bpms } from '../history/bpms'
import { getPreviewState, previewEdit } from '../preview/edit'
import { settings } from '../settings'
import { isSameTempo, type BpmIntegral, type GridBpm } from '../state/integrals/bpms'
import { GLOBAL_GRID, toBeatGrid } from '../state/integrals/grid'

// Measure and Both show bars, so beats snap from them; Beat keeps the global grid.
const isBarGrid = computed(() => settings.beatDisplay !== 'beat')

export const gridOf = (bpms: GridBpm[]) => (isBarGrid.value ? toBeatGrid(bpms) : GLOBAL_GRID)

/** A scaling drag's tempo and bars at its press: its draft moves BPM changes under it. */
export const dragBpms = shallowRef<BpmIntegral[]>()

// A pending Properties draft that keeps the tempo is drawn, so pointers snap to its bars too.
const snapBpms = computed(() => {
    if (!previewEdit.value?.isDraft) return bpms.value
    const draft = getPreviewState(state.value).bpms
    return isSameTempo(draft, bpms.value) ? draft : bpms.value
})

/** The committed chart's bar grid, whatever the display; a drawn draft's, as committedGrid. */
export const committedBarGrid = computed(() => toBeatGrid(snapBpms.value))

/** The grid pointers snap to, a drawn draft's too; BPM change moves keep it until the drop. */
export const committedGrid = computed(() => gridOf(snapBpms.value))
