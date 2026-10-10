import { fromDisplayedBeat } from '../../editor/beatDisplay'
import { alignFraction } from './numberStep'

// A step lands an ulp off its beat's grid; same-beat objects must be equal.
export const fromSteppedBeat = (value: number) => alignFraction(fromDisplayedBeat(value))
