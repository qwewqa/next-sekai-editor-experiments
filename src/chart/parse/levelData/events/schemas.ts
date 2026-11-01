import type { LevelDataEntity } from '@sonolus/core'
import Type from 'typebox'
import { getOptionalValue } from '..'
import { easeFromValue, easeLevelDataValues } from '../../../../ease'

// Typed as a union of numbers: typebox reads a union built from an array as never.
const eventEaseSchema = Type.Union(
    easeLevelDataValues.map((value) => Type.Literal(value)),
) as Type.TUnion<[Type.TLiteral<number>]>

/** An event's ease: absent reads 0, none, as in the engine. */
export const getEventEase = (entity: LevelDataEntity) =>
    easeFromValue(getOptionalValue(entity, 'ease', eventEaseSchema) ?? 0)
