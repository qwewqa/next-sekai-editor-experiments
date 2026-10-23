// What changed between what the strip shows and a state (design §3.3, steps 4 to 6): pure.
// A bucket's identity is its content: a transaction copies a bucket on its first write and
// deletes a key when its last entity goes, so an unchanged bucket is the same Set.

import type { State } from '../../state'
import type { ConnectorEntity } from '../../state/entities/slides/connector'
import type { NoteEntity } from '../../state/entities/slides/note'
import { beatToTime, timeToBeat, type BpmIntegral } from '../../state/integrals/bpms'
import type { MinimapMapping } from './mapping'

/** The grids the strip draws from. */
export type DrawnGrids = {
    note: Map<number, Set<NoteEntity>>
    connector: Map<number, Set<ConnectorEntity>>
}

/** More entities than this in the changed buckets make a full redraw cheaper than bands. */
export const MAX_BAND_ENTITIES = 256
/** More rows than this share of the canvas make a full redraw cheaper than bands. */
export const MAX_BAND_SHARE = 1 / 3
/** Device px added above and below a key's rows. */
export const BAND_MARGIN = 2

export const gridsOf = (state: Pick<State, 'store'>): DrawnGrids => ({
    note: state.store.grid.note,
    connector: state.store.grid.connector,
})

/**
 * Adds the keys of `next` whose bucket differs from `drawn`'s, then the keys `next` lacks, and
 * returns the entities they hold. Stops early once the count passes the threshold.
 */
const collectChanged = <T>(
    drawn: Map<number, Set<T>>,
    next: Map<number, Set<T>>,
    keys: Set<number>,
) => {
    if (drawn === next) return 0
    let entities = 0
    for (const [key, bucket] of next) {
        const before = drawn.get(key)
        if (before === bucket) continue
        keys.add(key)
        entities += Math.max(bucket.size, before?.size ?? 0)
        if (entities > MAX_BAND_ENTITIES) return entities
    }
    for (const [key, bucket] of drawn) {
        if (next.has(key)) continue
        keys.add(key)
        entities += bucket.size
        if (entities > MAX_BAND_ENTITIES) return entities
    }
    return entities
}

/** The keys to repaint, ascending, or `'full'` when too many entities changed. */
export const diffGrids = (drawn: DrawnGrids, next: DrawnGrids): number[] | 'full' => {
    const keys = new Set<number>()
    const entities =
        collectChanged(drawn.note, next.note, keys) +
        collectChanged(drawn.connector, next.connector, keys)
    if (entities > MAX_BAND_ENTITIES) return 'full'
    return [...keys].sort((a, b) => a - b)
}

/** Device rows, top included and bottom excluded. */
export type Band = { top: number; bottom: number }

/**
 * Each key covers the beats [key, key + 1) on the shown tempo. Its rows get a margin each side,
 * and overlapping or touching bands merge.
 */
export const keysToBands = (
    keys: readonly number[],
    bpms: BpmIntegral[],
    mapping: MinimapMapping,
): Band[] => {
    const { scale } = mapping.geometry
    const height = Math.max(1, Math.round(mapping.geometry.height * scale))
    const rows = keys
        .map((key) => ({
            top: Math.floor(mapping.timeToY(beatToTime(bpms, key + 1)) * scale - BAND_MARGIN),
            bottom: Math.ceil(mapping.timeToY(beatToTime(bpms, key)) * scale + BAND_MARGIN),
        }))
        .sort((a, b) => a.top - b.top)
    const bands: Band[] = []
    for (const row of rows) {
        const top = Math.max(0, row.top)
        const bottom = Math.min(height, row.bottom)
        if (bottom <= top) continue
        const last = bands.at(-1)
        if (last && top <= last.bottom) last.bottom = Math.max(last.bottom, bottom)
        else bands.push({ top, bottom })
    }
    return bands
}

/** Whether the bands take more of the canvas than a full redraw is worth. */
export const bandsTooTall = (bands: readonly Band[], backingHeight: number) =>
    bands.reduce((sum, { top, bottom }) => sum + bottom - top, 0) > backingHeight * MAX_BAND_SHARE

/**
 * The keys whose entities can touch a band's rows: the band's own, plus 2 device px each side for
 * a note's height and a body's antialiasing. Infinite where the range reaches time 0 or the end.
 */
export const bandKeyRange = (band: Band, bpms: BpmIntegral[], mapping: MinimapMapping) => {
    const { scale } = mapping.geometry
    const reach = 2 / scale
    const zeroY = mapping.timeToY(0)
    const endY = mapping.timeToY(mapping.end)
    const top = band.top / scale - reach
    const bottom = band.bottom / scale + reach
    return {
        lo: bottom >= zeroY ? -Infinity : Math.floor(timeToBeat(bpms, mapping.yToTime(bottom))),
        hi: top <= endY ? Infinity : Math.floor(timeToBeat(bpms, mapping.yToTime(top))),
    }
}
