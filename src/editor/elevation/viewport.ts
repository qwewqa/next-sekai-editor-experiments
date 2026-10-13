import { ref, shallowReactive, shallowRef } from 'vue'
import { onResetState } from '../../history/resetHooks'
import { clamp } from '../../utils/math'
import type { EditorNavigation } from '../navigation'
import type { ElevationNote } from './layout'

export const elevationViewport = shallowReactive({ center: 2.5, scale: 64 })
export const elevationBounds = shallowReactive({ x: 0, y: 0, w: 0, h: 0 })
/** Whether a navigation is the Elevation Editor's, which moves in its bounds. */
export const isElevationNavigation = (navigation: EditorNavigation | undefined) =>
    navigation?.bounds === elevationBounds
// The box selection being dragged, in lanes and elevations, so it stays on them as the view moves.
export const elevationSelection = shallowRef<{
    laneMin: number
    laneMax: number
    elevationMin: number
    elevationMax: number
}>()
// The first open after a chart load fits the view; until it's adjusted, a new pane size fits it again.
export const needsElevationFit = ref(true)
// The pane size of the fit, until the view is first adjusted; a new size fits it again.
export const elevationFitSize = shallowRef<{ w: number; h: number }>()
onResetState(() => {
    needsElevationFit.value = true
})
/** Centres between the paddings at this scale: 0 16px off the bottom, then the notes, then 3. */
export const fitElevationViewport = (
    height: number,
    notes: ElevationNote[],
    scale: number,
    padding = { top: 80, bottom: 140 },
    noteMargin = 0,
) => {
    const top = Math.min(padding.top, Math.max(0, height - 1))
    const bottom = Math.min(padding.bottom, Math.max(0, (height - top) / 2))
    // The band's reach above and below the centre, in elevations.
    const above = (height / 2 - top) / scale
    const below = (height / 2 - bottom) / scale
    // The centres showing 0; a band too short for the margin takes the middle.
    let min = -above
    let max = below - 16 / scale
    if (min > max) min = max = (min + max) / 2
    if (notes.length) {
        const margin = noteMargin / scale
        const notesMin = Math.max(...notes.map((note) => note.elevation)) - above + margin
        const notesMax = Math.min(...notes.map((note) => note.elevation)) + below - margin
        if (Math.max(min, notesMin) <= Math.min(max, notesMax)) {
            min = Math.max(min, notesMin)
            max = Math.min(max, notesMax)
        } else {
            // Notes too spread to fit with 0: as near their middle as 0 allows.
            min = max = clamp((notesMin + notesMax) / 2, min, max)
        }
    }
    elevationViewport.scale = scale
    elevationViewport.center = clamp(3, min, max)
}
