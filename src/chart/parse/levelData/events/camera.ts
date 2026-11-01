import { EngineArchetypeDataName } from '@sonolus/core'
import Type from 'typebox'
import { getEventRefs, parseEvents } from '.'
import { getOptionalValue, getValue, type ParseCtx } from '..'
import { ImportRefusal } from '../../../refusal'
import { beatSchema } from '../schemas'
import { getEventEase } from './schemas'

export const parseCameraEventsToChart = (
    { chart, entities }: ParseCtx,
    firstRef: string | undefined,
) => {
    if (!firstRef) return
    if (!chart.isDynamicStages) throw new ImportRefusal('dynamicStages')

    const refs = getEventRefs(entities, 'CameraChange')

    parseEvents(refs, firstRef, chart.cameraEvents, (entity) => {
        const lane = getOptionalValue(entity, 'lane', laneSchema) ?? 0
        const size = getOptionalValue(entity, 'size', sizeSchema) ?? 0

        return {
            beat: getValue(entity, EngineArchetypeDataName.Beat, beatSchema),
            cameraLeft: lane - size,
            cameraSize: size * 2,
            cameraZoom: getOptionalValue(entity, 'zoom', zoomSchema) ?? 1,
            cameraZoomTargetLane:
                getOptionalValue(entity, 'zoomTargetLane', zoomTargetLaneSchema) ?? 0,
            cameraZoomTargetY: getOptionalValue(entity, 'zoomTargetY', zoomTargetYSchema) ?? 0,
            cameraZoomVerticalAlign:
                zoomVerticalAligns[
                    getOptionalValue(entity, 'zoomVerticalAlign', zoomVerticalAlignSchema) ?? 0
                ],
            cameraRotation: getOptionalValue(entity, 'rotate', rotateSchema) ?? 0,
            cameraStageTilt: getOptionalValue(entity, 'stageTilt', stageTiltSchema) ?? 1,
            eventEase: getEventEase(entity),
        }
    })
}

const laneSchema = Type.Number()

// Sampling reads a size below 0.01 as 0.01.
const sizeSchema = Type.Number({ minimum: 0 })

const zoomSchema = Type.Number({ minimum: 0.01 })

const zoomTargetLaneSchema = Type.Number()

const zoomTargetYSchema = Type.Number({ minimum: -1, maximum: 1 })

const zoomVerticalAlignSchema = Type.Union([Type.Literal(0), Type.Literal(1)])

const zoomVerticalAligns = {
    0: 'default',
    1: 'center',
} as const

const rotateSchema = Type.Number()

const stageTiltSchema = Type.Number({ minimum: 0, maximum: 1 })
