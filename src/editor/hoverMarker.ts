import { computed } from 'vue'
import { bpms } from '../history/bpms'
import { isPlaying } from '../player'
import { beatToTime } from '../state/integrals/bpms'
import { sceneBpms } from './sceneState'
import { view } from './view'

// Hidden while playing; a cursor marker shows only while the cursor stays where the tap put it.
const touchMarkerTime = computed(() => {
    const marker = view.touchMarker
    if (!marker || isPlaying.value) return
    if (marker.kind === 'entity') return beatToTime(sceneBpms.value, marker.beat)
    return beatToTime(bpms.value, marker.beat) === view.cursorTime ? view.cursorTime : undefined
})

/** The hover line's time: the mouse or drag hover's, else the touch marker's, else none. */
export const shownMarkerTime = computed(() =>
    view.isHoverHidden ? touchMarkerTime.value : view.hoverTime,
)
