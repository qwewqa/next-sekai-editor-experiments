import { EngineArchetypeDataName } from '@sonolus/core'
import Type from 'typebox'
import { parseStageEvents } from '.'
import { getEventRefs } from '..'
import { getOptionalValue, getValue, type ParseCtx } from '../..'
import { ImportRefusal } from '../../../../refusal'
import type { StageId } from '../../../../stages'
import { beatSchema } from '../../schemas'
import { getEventEase } from '../schemas'

export const parseStageTransformEventsToChart = (
    { chart, entities }: ParseCtx,
    firstRefs: Map<StageId, string>,
) => {
    if (!firstRefs.size) return
    if (!chart.isDynamicStages) throw new ImportRefusal('dynamicStages')

    const refs = getEventRefs(entities, 'StageTransformChange')

    parseStageEvents(refs, firstRefs, chart.stageTransformEvents, (stageId, entity) => ({
        stageId,
        beat: getValue(entity, EngineArchetypeDataName.Beat, beatSchema),
        rotation: getOptionalValue(entity, 'rotate', rotateSchema) ?? 0,
        xTranslation: getOptionalValue(entity, 'xLaneTranslate', xLaneTranslateSchema) ?? 0,
        yTranslation: getOptionalValue(entity, 'yLaneTranslate', yLaneTranslateSchema) ?? 0,
        elevation: getOptionalValue(entity, 'elevation', elevationSchema) ?? 0,
        anchor: anchors[getOptionalValue(entity, 'anchor', anchorSchema) ?? 0],
        rotationCenter:
            rotationCenters[getOptionalValue(entity, 'rotationCenter', rotationCenterSchema) ?? 0],
        centerXOffset: getOptionalValue(entity, 'rotationCenterXOffset', offsetSchema) ?? 0,
        centerYOffset: getOptionalValue(entity, 'rotationCenterYOffset', offsetSchema) ?? 0,
        eventEase: getEventEase(entity),
    }))
}

const rotateSchema = Type.Number()

const xLaneTranslateSchema = Type.Number()

const yLaneTranslateSchema = Type.Number()

const elevationSchema = Type.Number()

const anchorSchema = Type.Union([Type.Literal(0), Type.Literal(1)])

const anchors = {
    0: 'default',
    1: 'center',
} as const

const rotationCenterSchema = Type.Union([
    Type.Literal(0),
    Type.Literal(1),
    Type.Literal(2),
    Type.Literal(3),
])

const rotationCenters = {
    0: 'mask',
    1: 'stage',
    2: 'screen',
    3: 'vanishingPoint',
} as const

const offsetSchema = Type.Number()
