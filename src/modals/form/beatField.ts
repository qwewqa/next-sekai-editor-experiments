import { fromDisplayedBeat, toDisplayedBeat } from '../../editor/beatDisplay'
import { addDecimal, alignFraction } from './numberStep'

// The Beat field's 1-based beat, added in decimal: typed 1.01 holds 0.01, not 0.010000000000000009.
export const toFieldBeat = (beat: number) => addDecimal(beat, toDisplayedBeat(0))
export const fromFieldBeat = (value: number) => addDecimal(value, fromDisplayedBeat(0))

// A step lands an ulp off its beat's grid; same-beat objects must be equal.
export const fromSteppedBeat = (value: number) => alignFraction(fromFieldBeat(value))
