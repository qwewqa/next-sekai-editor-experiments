import { CHANGE_COLOR } from '../canvas/changes'
import type { Place } from '../history/changeStops'
import { minimapChangePlaces } from '../history/changes'
import type { MinimapAnnotation } from './annotations'
import { HAIRLINE_ALPHA, TICK_WIDTH, hairlineRuns, tickRuns, type TickRun } from './tickRuns'

/**
 * Orange marks at the places the peeked step changed (design §10.6): an edge tick per run, and
 * for a few short runs a faint hairline across the strip, so a lone change reads against the notes.
 */
export const changeTicks: MinimapAnnotation<readonly Place[]> = {
    inputs: () => {
        const places = minimapChangePlaces.value
        return places && places.length > 0 ? places : undefined
    },
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
        for (const { top, height } of runs) ctx.fillRect(0, top, TICK_WIDTH, height)
    },
}
