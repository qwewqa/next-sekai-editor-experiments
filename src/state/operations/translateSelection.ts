import type { State } from '..'
import type { Entity } from '../entities'
import {
    addBeatOffset,
    getScaleProperties,
    getTranslatedSelectionValues,
    type ScaleAxis,
} from './scaleValues'
import { transformSelection } from './transformSelection'

export const translateSelection = (
    source: State,
    selected: Entity[],
    axis: ScaleAxis,
    delta: number,
    moveBeat = addBeatOffset,
): State => {
    const values = getTranslatedSelectionValues(selected, axis, delta, source, moveBeat)
    return values
        ? transformSelection(
              source,
              selected,
              new Map(
                  [...values].map(([entity, value]) => [
                      entity,
                      getScaleProperties(entity, axis, value),
                  ]),
              ),
          )
        : source
}
