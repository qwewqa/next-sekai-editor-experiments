import { forEachExported, inCombo } from '../../levelData/scoring'
import { beatToTime } from '../../state/integrals/bpms'
import type { PreviewChart, PreviewNoteChain } from './model'

// Tempo edits replace chains but keep their infos, so each slide keeps one weak key.
const slideTimes = new WeakMap<
    PreviewNoteChain['infos'],
    { bpms: PreviewNoteChain['bpms']; times: Float64Array }
>()
const chartTimes = new WeakMap<PreviewNoteChain[], Float64Array>()

export const getComboTimes = (chart: PreviewChart): Float64Array => {
    const cached = chartTimes.get(chart.chains)
    if (cached) return cached

    const lists = chart.chains.map((chain) => {
        const cached = slideTimes.get(chain.infos)
        if (cached?.bpms === chain.bpms) return cached.times

        const times: number[] = []
        forEachExported(chain.infos, (row, beat) => {
            if (!inCombo(row)) return
            const time = beatToTime(chain.bpms, beat)
            // Keep invalid events in the total, after every countable time.
            times.push(Number.isFinite(time) ? time : Infinity)
        })
        const sorted = Float64Array.from(times).sort()
        slideTimes.set(chain.infos, { bpms: chain.bpms, times: sorted })
        return sorted
    })
    if (lists.length === 1 && lists[0]) {
        const times = lists[0]
        chartTimes.set(chart.chains, times)
        return times
    }
    const times = new Float64Array(lists.reduce((sum, list) => sum + list.length, 0))
    let offset = 0
    for (const list of lists) {
        times.set(list, offset)
        offset += list.length
    }
    times.sort()
    chartTimes.set(chart.chains, times)
    return times
}

export const comboAt = (times: Float64Array, t: number, leftLimit: boolean): number => {
    let lo = 0
    let hi = times.length
    while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2)
        const time = times[mid] ?? Infinity
        if (Number.isFinite(time) && (leftLimit ? time < t : time <= t)) lo = mid + 1
        else hi = mid
    }
    return lo
}
