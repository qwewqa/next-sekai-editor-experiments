import type { State } from '..'
import type { Entity } from '../entities'
import {
    addBeatOffset,
    getScaleProperties,
    getTranslatedSelectionValues,
    type ScaleAxis,
} from './scaleValues'
import { transformSelectionWithReceipt, type SelectionTransformResult } from './transformSelection'

export const translateSelectionWithReceipt = (
    source: State,
    selected: Entity[],
    axis: ScaleAxis,
    delta: number,
    moveBeat = addBeatOffset,
    division = 1,
): SelectionTransformResult => {
    const values = getTranslatedSelectionValues(selected, axis, delta, source, moveBeat, division)
    return values
        ? transformSelectionWithReceipt(
              source,
              selected,
              new Map(
                  [...values].map(([entity, value]) => [
                      entity,
                      getScaleProperties(entity, axis, value),
                  ]),
              ),
          )
        : {
              state: source,
              counts: {},
              replacements: new Map(selected.map((entity) => [entity, entity])),
              applications: new Map<Entity, Entity>(),
          }
}

export const translateSelection = (
    source: State,
    selected: Entity[],
    axis: ScaleAxis,
    delta: number,
    moveBeat = addBeatOffset,
    division = 1,
): State => translateSelectionWithReceipt(source, selected, axis, delta, moveBeat, division).state
