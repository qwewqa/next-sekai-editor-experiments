// The minimap's time range (design §3.4): pure. The range runs from time 0 to the last note,
// rounded up to a step that grows with the chart, so adding notes near the end rarely moves it.

import type { State } from '../../state'
import type { NoteEntity } from '../../state/entities/slides/note'
import { beatToTime } from '../../state/integrals/bpms'

/** The shortest range, in seconds. */
export const MIN_END = 10

type NoteGrid = Map<number, Set<NoteEntity>>

const lastBeats = new WeakMap<NoteGrid, number | undefined>()

/**
 * The last note's beat. Map keys are in insertion order, so the largest key is searched for, then
 * the largest beat in its bucket. Anchors count; events, BPM changes and the BGM's length do not.
 */
export const lastBeatOf = (grid: NoteGrid): number | undefined => {
    if (lastBeats.has(grid)) return lastBeats.get(grid)
    let key: number | undefined
    for (const candidate of grid.keys()) if (key === undefined || candidate > key) key = candidate
    let last: number | undefined
    if (key !== undefined)
        for (const { beat } of grid.get(key) ?? [])
            if (last === undefined || beat > last) last = beat
    lastBeats.set(grid, last)
    return last
}

/** `last` is the last note's time in seconds. */
export const endForLastTime = (last: number | undefined) => {
    if (last === undefined || !(last > 0)) return MIN_END
    const step = Math.max(1, 2 ** Math.ceil(Math.log2(last / 64)))
    return Math.max(MIN_END, Math.ceil(last / step) * step + step)
}

/**
 * A state's own range. The last beat is cached by the note grid, but converted to time on every
 * call with the state's tempo, because a BPM edit moves the end without touching the grid.
 */
export const endOf = (state: Pick<State, 'bpms' | 'store'>) => {
    const beat = lastBeatOf(state.store.grid.note)
    return endForLastTime(
        beat === undefined ? undefined : beatToTime(state.bpms, Math.max(0, beat)),
    )
}

/** While peeking, the larger of the live and peeked ends: one scale across entries. */
export const computeEnd = (
    shown: Pick<State, 'bpms' | 'store'>,
    live: Pick<State, 'bpms' | 'store'>,
    peeking: boolean,
) => (peeking ? Math.max(endOf(live), endOf(shown)) : endOf(shown))
