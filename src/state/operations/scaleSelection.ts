import type { State } from '..'
import type { Entity } from '../entities'
import {
    addBeatOffset,
    getScaleProperties,
    getScaledSelectionValues,
    type ScaleAxis,
} from './scaleValues'
import { transformSelectionWithReceipt, type SelectionTransformResult } from './transformSelection'

export type { ScaleAxis } from './scaleValues'

export const scaleSelectionWithReceipt = (
    source: State,
    selected: Entity[],
    axis: ScaleAxis,
    factor: number,
    anchor?: number,
    moveBeat = addBeatOffset,
    division = 1,
): SelectionTransformResult => {
    const values = getScaledSelectionValues(
        selected,
        axis,
        factor,
        source,
        anchor,
        moveBeat,
        division,
    )
    return values
        ? transformSelectionWithReceipt(
              source,
              selected,
              new Map(
                  [...values].map(([entity, value]) => [
                      entity,
                      getScaleProperties(entity, axis, value, factor),
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

export const scaleSelection = (
    source: State,
    selected: Entity[],
    axis: ScaleAxis,
    factor: number,
    anchor?: number,
    moveBeat = addBeatOffset,
    division = 1,
): State =>
    scaleSelectionWithReceipt(source, selected, axis, factor, anchor, moveBeat, division).state
