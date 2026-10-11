import type { State } from '..'
import type { Entity } from '../entities'
import {
    addBeatOffset,
    getScaleProperties,
    getScaledSelectionValues,
    type ScaleAxis,
} from './scaleValues'
import { transformSelection } from './transformSelection'

export type { ScaleAxis } from './scaleValues'

export const scaleSelection = (
    source: State,
    selected: Entity[],
    axis: ScaleAxis,
    factor: number,
    anchor?: number,
    moveBeat = addBeatOffset,
): State => {
    const values = getScaledSelectionValues(selected, axis, factor, source, anchor, moveBeat)
    return values
        ? transformSelection(
              source,
              selected,
              new Map(
                  [...values].map(([entity, value]) => [
                      entity,
                      getScaleProperties(entity, axis, value, factor),
                  ]),
              ),
          )
        : source
}
