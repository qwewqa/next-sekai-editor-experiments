import { isPeeking, state } from '../../history'
import { settings } from '../../settings'
import { beatToMeasure, roundBoundary, timeToBeat, type GridBpm } from '../../state/integrals/bpms'
import { formatBeatPosition } from '../beatDisplay'
import { bandTimes } from './changes'
import { showHistoryLink } from './openHistory'
import { peekedSession } from './selection'
import { hereRange, historyFilter } from './state'

// Edits Here: the Timeline filtered to the entries that changed a range of
// beats, taken once as it is chosen: the selection's beats at Now, else the beats in view. Shared
// by Go To's Show list, the chart's context menu and the Find Edits Here command.

/** The start of the grid beat a chart beat is in, as the beat labels count them. */
const beatStart = (bpms: GridBpm[], beat: number) => {
    if (settings.beatDisplay === 'beat') return Math.floor(beat)
    const position = roundBoundary(beatToMeasure(bpms, beat).beat)
    return beat - (position - Math.floor(position))
}

/** The first and last beat of some entities: a loop, since a spread into a call fails for a large selection. */
export const beatSpan = (entities: readonly { beat: number }[]) => {
    let from = Infinity
    let to = -Infinity
    for (const { beat } of entities) {
        if (beat < from) from = beat
        if (beat > to) to = beat
    }
    return { from, to }
}

/**
 * The beats Edits Here would use now: whole grid beats, from the one `from` is in to the end of
 * the one `last` starts, which its label names (X-B 1).
 */
export const takeHereRange = () => {
    const shown = state.value
    const selected = isPeeking.value ? [] : shown.selectedEntities
    let span: { from: number; to: number }
    if (selected.length) span = beatSpan(selected)
    else {
        const band = bandTimes()
        span = {
            from: timeToBeat(shown.bpms, Math.max(0, band.bottom)),
            to: timeToBeat(shown.bpms, Math.max(0, band.top)),
        }
    }
    const first = Math.max(0, beatStart(shown.bpms, span.from))
    const last = Math.max(first, beatStart(shown.bpms, span.to))
    // Up to the end of the last beat. The end itself is within a rounding of the next beat, so
    // the label names the last beat's start rather than reading it back from the end.
    return { from: first, to: last + 1 - 1e-9, last }
}

/** A range as the grid labels write its first and last beats: "118.2 – 121.4". */
export const hereRangeText = (range: { from: number; last: number }) => {
    const bpms = state.value.bpms
    const at = (beat: number) => formatBeatPosition(bpms, beat, settings.beatDisplay)
    return `${at(range.from)} – ${at(range.last)}`
}

/** Turns Edits Here on with the beats it takes now. */
export const filterHere = () => {
    hereRange.value = takeHereRange()
    historyFilter.value = 'here'
}

/** Find Edits Here: the filter on, and History shown the way links show it. */
export const findEditsHere = () => {
    // A session's peek shows another chain's chart: its beats say nothing of this Timeline.
    if (peekedSession.value) return
    filterHere()
    showHistoryLink('timeline')
}
