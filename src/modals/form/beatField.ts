import { fromDisplayedBeat } from '../../editor/beatDisplay'
import { nearGridsBeat, type BeatGrid } from '../../state/integrals/grid'
import { alignFraction } from './numberStep'

// A step lands an ulp off its beat's grid line, a bar grid's too; same-beat objects must be equal.
export const fromSteppedBeat = (value: number, grids: BeatGrid[], division: number) =>
    nearGridsBeat(grids, alignFraction(fromDisplayedBeat(value)), division)
