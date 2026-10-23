import { CHANGE_COLOR } from '../canvas/changes'
import type { Place } from '../history/changeStops'
import { minimapChangePlaces } from '../history/changes'
import type { MinimapAnnotation } from './annotations'
import { TICK_WIDTH, tickRuns } from './tickRuns'

/** Orange ticks at the places the peeked step changed (design §10.6). */
export const changeTicks: MinimapAnnotation<readonly Place[]> = {
    inputs: () => {
        const places = minimapChangePlaces.value
        return places && places.length > 0 ? places : undefined
    },
    paint: (ctx, mapping, places) => {
        ctx.fillStyle = CHANGE_COLOR
        tickRuns(places, mapping, (top, height) => {
            ctx.fillRect(0, top, TICK_WIDTH, height)
        })
    },
}
