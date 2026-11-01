import type { BaseStageEventJointEntity } from '.'
import type {
    Anchor,
    RotationCenter,
    StageTransformEventObject,
} from '../../../../../chart/events/stage/transform'

export type StageTransformEventJointEntity = BaseStageEventJointEntity & {
    type: 'stageTransformEventJoint'
    rotation: number
    xTranslation: number
    yTranslation: number
    elevation: number
    anchor: Anchor
    rotationCenter: RotationCenter
    centerXOffset: number
    centerYOffset: number
}

export const toStageTransformEventJointEntity = (
    object: StageTransformEventObject,
): StageTransformEventJointEntity => ({
    type: 'stageTransformEventJoint',
    hitbox: {
        lane: object.xTranslation,
        beat: object.beat,
        w: 0.2,
        h: 0.2,
    },

    stageId: object.stageId,
    beat: object.beat,
    rotation: object.rotation,
    xTranslation: object.xTranslation,
    yTranslation: object.yTranslation,
    elevation: object.elevation,
    anchor: object.anchor,
    rotationCenter: object.rotationCenter,
    centerXOffset: object.centerXOffset,
    centerYOffset: object.centerYOffset,
    eventEase: object.eventEase,
})
