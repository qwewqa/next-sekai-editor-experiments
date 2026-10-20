// Where a peeked entry's changes are, for the edge arrows and Show Change (Part 1 §1.4.11): each
// change's time and lanes, grouped into stops that fit on screen. Pure, so Node tests run it.

/** A change's place: its time, and a note's lanes. */
export type Place = { time: number; left: number; right: number; id?: number }

/** Changes close enough to show together: from the first's time to the last's. */
export type Stop = { from: number; to: number; left: number; right: number }

/**
 * The band in view, in times: `top` is later than `bottom`, as time runs up. `floor` is the lowest
 * time the band can ever show, its bottom at view time 0, as the view never goes below the chart's
 * start (absent: no limit).
 */
export type Band = { top: number; bottom: number; floor?: number }

/** The places a scroll can bring into the band: none earlier than its floor. */
export const reachable = <T extends Place>(places: readonly T[], floor = -Infinity) =>
    floor === -Infinity ? places : places.filter(({ time }) => time >= floor)

/** Places in time order grouped into stops, each within 80% of `span` from its first. */
export const stopsOf = (places: readonly Place[], span: number): Stop[] => {
    const stops: Stop[] = []
    let current: Stop | undefined
    for (const place of places) {
        if (current && place.time <= current.from + 0.8 * span) {
            current.to = place.time
            current.left = Math.min(current.left, place.left)
            current.right = Math.max(current.right, place.right)
            continue
        }
        current = { from: place.time, to: place.time, left: place.left, right: place.right }
        stops.push(current)
    }
    return stops
}

/** Changes wholly beyond the band's top and its bottom, and a scroll can reach. */
export const countOff = (places: readonly Place[], band: Band) => {
    const above = new Set<number>()
    const below = new Set<number>()
    for (const [index, { time, id = index }] of places.entries()) {
        if (time < (band.floor ?? -Infinity)) continue
        if (time > band.top) above.add(id)
        else if (time < band.bottom) below.add(id)
    }
    return { above: above.size, below: below.size }
}

const middleOf = ({ from, to }: Stop) => (from + to) / 2

/** Whether every change is already in view: then nothing moves. */
const allInView = (stops: readonly Stop[], band: Band) =>
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    !stops.length || (stops[0]!.from >= band.bottom && stops.at(-1)!.to <= band.top)

/** Show Change: the next stop above the band's middle, wrapping to the lowest. */
export const nextStop = (stops: readonly Stop[], band: Band) => {
    if (allInView(stops, band)) return
    const middle = (band.top + band.bottom) / 2
    return stops.find((stop) => middleOf(stop) > middle + 1e-6) ?? stops[0]
}

/** An edge arrow: the nearest stop wholly beyond the band that way. */
export const stopToward = (stops: readonly Stop[], band: Band, direction: 'up' | 'down') =>
    direction === 'up'
        ? stops.find((stop) => stop.from > band.top)
        : stops.filter((stop) => stop.to < band.bottom).at(-1)

/** The row menu's Show Change: the stop nearest the band's middle. */
export const nearestStop = (stops: readonly Stop[], band: Band) => {
    if (allInView(stops, band)) return
    const middle = (band.top + band.bottom) / 2
    const distance = (stop: Stop) => Math.abs(middleOf(stop) - middle)
    return stops.reduce((best, stop) => (distance(stop) < distance(best) ? stop : best))
}
