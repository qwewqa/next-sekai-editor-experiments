import { beatToMeasure, type GridBpm } from '../state/integrals/bpms'
import { addDecimal } from '../utils/math'

export type BeatDisplay = 'beat' | 'measure' | 'both'

// Added in decimal: 0.14 shows as 1.14, and typed 1.01 holds 0.01, not 0.010000000000000009.
export const toDisplayedBeat = (chartBeat: number) => addDecimal(chartBeat, 1)
export const fromDisplayedBeat = (displayedBeat: number) => addDecimal(displayedBeat, -1)

export const formatBeatPosition = (
    bpms: GridBpm[],
    chartBeat: number,
    display: BeatDisplay,
    fractional = false,
) => {
    // Rounds to the shown thousandth first, so 3.9999 reads 2.1 rather than 1.5.
    if (fractional) chartBeat = Math.round(chartBeat * 1000) / 1000
    const beat = toDisplayedBeat(chartBeat)
    // Bar grid labels can sit at thirds.
    const beatText = fractional ? beat.toFixed(3) : `${Number(beat.toFixed(3))}`
    if (display === 'beat') return beatText
    const position = beatToMeasure(bpms, chartBeat)
    const measureBeat = position.beat.toFixed(3)
    const measureText = `${position.measure}.${fractional ? measureBeat : Number(measureBeat)}`
    return display === 'both' ? `${measureText} (${beatText})` : measureText
}
