import { computed } from 'vue'
import { CHANGE_COLOR } from '../canvas/changes'
import type { Place } from '../history/changeStops'
import { minimapChangePlaces } from '../history/changes'
import type { MinimapLayer } from './layers'
import { gutterMarkEdges } from './mapping'
import { HAIRLINE_ALPHA, hairlineRuns, tickRuns, type TickRun } from './tickRuns'

/**
 * Orange marks at the places the peeked step changed: an edge tick per run, and
 * for a few short runs a faint hairline across the strip, so a lone change reads against the notes.
 */
export const changeTicks: MinimapLayer<readonly Place[]> = {
    useInputs: () =>
        computed(() => {
            const places = minimapChangePlaces.value
            return places && places.length > 0 ? places : undefined
        }),
    counter: 'changePaints',
    paint: (ctx, mapping, places) => {
        const runs: TickRun[] = []
        tickRuns(places, mapping, (top, height) => runs.push({ top, height }))
        const { width, scale } = mapping.geometry
        ctx.fillStyle = CHANGE_COLOR
        // Hairlines first, one device px tall on a device row, so the edge ticks cover their start.
        ctx.globalAlpha = HAIRLINE_ALPHA
        for (const { top, height } of hairlineRuns(runs))
            ctx.fillRect(0, Math.floor((top + height / 2) * scale) / scale, width, 1 / scale)
        ctx.globalAlpha = 1
        const { tick } = gutterMarkEdges(mapping.geometry)
        for (const { top, height } of runs) ctx.fillRect(0, top, tick, height)
    },
}
