import { fromDisplayedBeat } from '../../editor/beatDisplay'
import { cleanBeat, type BeatGrid } from '../../state/integrals/grid'

// A step lands an ulp off its beat's grid line, a bar grid's too; same-beat objects must be equal.
export const fromSteppedBeat = (value: number, grids: BeatGrid[], division: number) =>
    cleanBeat(grids, fromDisplayedBeat(value), division)
