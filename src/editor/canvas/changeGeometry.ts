import type { Entity } from '../../state/entities'
import { BPM_LABEL } from '../../state/entities/bpm'
import { getNoteVisualType } from '../../state/entities/slides/visualType'
import { beatToTime } from '../../state/integrals/bpms'
import { jointXs } from './events'
import { diamondPoints } from './notes'
import type { EditorDrawContext } from './types'

export type ChangeShape = {
    x: number
    y: number
    w: number
    h: number
    kind: 'note' | 'circle' | 'diamond' | 'range' | 'bpm'
    radius?: number
    points?: readonly (readonly [number, number])[]
}

/** Native body and glyph footprints, independent of interaction hitboxes. */
export const changeShape = (
    context: EditorDrawContext,
    entity: Entity,
): ChangeShape | undefined => {
    const y = beatToTime(context.state.bpms, entity.beat) * context.ups
    if (entity.type === 'note') {
        const box =
            context.composed?.hitbox(entity, {
                slideInfos: context.state.store.slides.info.get(entity.slideId),
            }) ?? entity.hitbox
        if (!box) return
        const type = getNoteVisualType(entity, context.state.store.slides.info.get(entity.slideId))
        const width = box.w > 0 ? box.w * 2 : 0.2
        const x = box.lane - width / 2
        if (type === 'tick' && box.w > 0)
            return {
                kind: 'diamond',
                x: box.lane - 0.3,
                y: y - 0.3,
                w: 0.6,
                h: 0.45,
                points: diamondPoints.map(([x, dy]) => [box.lane + x, y + dy]),
            }
        const h =
            type === 'anchor' || type === 'damage' || type === 'trace' || type === 'tick'
                ? 0.3
                : 0.6
        return { kind: 'note', x, y: y - h / 2, w: width, h, radius: 0.1 }
    }
    if (entity.type === 'bpm')
        return { kind: 'bpm', x: BPM_LABEL.lane, y: y - 0.22, w: 0.1, h: 0.44 }
    if (entity.type === 'timeScale') {
        const r = entity.timeScaleTransition === 'scroll' ? 0.135 : 0.1
        return {
            kind: entity.timeScaleTransition === 'scroll' ? 'diamond' : 'circle',
            x: entity.editorLane - r,
            y: y - r,
            w: r * 2,
            h: r * 2,
        }
    }
    if (!entity.type.endsWith('Joint')) return
    if (!('min' in entity) && 'type' in entity) {
        const xs = jointXs(entity as Parameters<typeof jointXs>[0])
        const x = xs[0] ?? 0
        return {
            kind: xs.length > 1 ? 'range' : 'circle',
            x: x - 0.1,
            y: y - 0.1,
            w: (xs[1] ?? x) - x + 0.2,
            h: 0.2,
        }
    }
}
