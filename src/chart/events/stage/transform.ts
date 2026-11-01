import type { EventEase } from '..'
import type { StageId } from '../../stages'

export type Anchor = 'default' | 'center'

export type RotationCenter = 'mask' | 'stage' | 'screen' | 'vanishingPoint'

export type StageTransformEventObject = {
    stageId: StageId
    beat: number
    rotation: number
    xTranslation: number
    yTranslation: number
    elevation: number
    anchor: Anchor
    rotationCenter: RotationCenter
    centerXOffset: number
    centerYOffset: number
    eventEase: EventEase
}
