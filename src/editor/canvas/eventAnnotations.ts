import type { WebGLDrawContext } from '../../rendering/context'
import { getTextRasterFontGeneration } from '../../rendering/textRaster'
import type { Entity } from '../../state/entities'
import { BPM_LABEL, type BpmEntity } from '../../state/entities/bpm'
import type { TimeScaleEntity } from '../../state/entities/timeScale'
import { beatToTime } from '../../state/integrals/bpms'
import { formatBpm } from '../../utils/format'
import {
    drawTimeScaleGroupName,
    timeScaleEaseGlyph,
    timeScaleLabel,
    timeScaleLabelDirection,
} from './events'
import { normalizeSvgText } from './text'
import type { EditorDrawContext } from './types'

type AnnotationEntity = BpmEntity | TimeScaleEntity
type PreparedLabel = ReturnType<WebGLDrawContext['prepareEditorLabel']>
type PreparedGlyph = NonNullable<ReturnType<WebGLDrawContext['prepareEaseGlyph']>>
type TimeScaleLayout = ReturnType<typeof timeScaleLabel>
type Entry = {
    label: PreparedLabel
    x: number
    time: number
    frame: number
    timeScale?: {
        layout: TimeScaleLayout
        glyph: PreparedGlyph
        x: number
        opacity: number
    }
}

const maxEntries = 4096

/** Visible event labels keep layout/ease geometry and stable device-pixel text baselines. */
export class EventAnnotations {
    private context?: EditorDrawContext
    private key: unknown[] = []
    private readonly entries = new Map<AnnotationEntity, Entry>()
    private frame = 0

    beginFrame(context: EditorDrawContext, labels: readonly { entity: Entity }[]) {
        const { ctx, state } = context
        const matrix = ctx.getTransform()
        const key = [
            ctx,
            ctx.resourceOwner,
            ctx.canvas.width,
            ctx.canvas.height,
            matrix.a,
            matrix.b,
            matrix.c,
            matrix.d,
            state.bpms,
            state.store.grid.timeScale,
            context.scale,
            context.fontFamily,
            context.figureMiddle,
            getTextRasterFontGeneration(),
        ]
        if (
            key.length !== this.key.length ||
            key.some((value, index) => value !== this.key[index])
        ) {
            this.clear()
            this.key = key
        }
        this.context = context
        this.frame++
        // Release old geometry before a jump builds the next visible working set.
        const visible = new Set(labels.map(({ entity }) => entity))
        for (const [entity, entry] of this.entries)
            if (!visible.has(entity)) this.remove(entity, entry)
    }

    draw(context: EditorDrawContext, entity: Entity, highlighted: boolean, opacity = 1) {
        if (
            context.ctx !== this.context?.ctx ||
            context.state !== this.context.state ||
            (entity.type !== 'bpm' && entity.type !== 'timeScale')
        )
            return false
        let entry = this.entries.get(entity)
        if (
            entity.type === 'timeScale' &&
            entry?.timeScale &&
            timeScaleLabelDirection(
                entity.editorLane,
                entry.timeScale.layout.width,
                context.bounds,
            ) !== entry.timeScale.layout.direction
        ) {
            this.remove(entity, entry)
            entry = undefined
        }
        if (!entry) {
            if (this.entries.size >= maxEntries) return false
            entry = this.create(context, entity)
            if (!entry) return false
            this.entries.set(entity, entry)
        }
        const { ctx } = context
        // Vertical zoom changes placement, not the prepared label or local ease geometry.
        const y = entry.time * context.ups
        if (
            entry.timeScale &&
            !ctx.drawPreparedEaseGlyph(
                entry.timeScale.glyph,
                entry.timeScale.x,
                y,
                opacity * entry.timeScale.opacity,
            )
        ) {
            this.remove(entity, entry)
            return false
        }
        ctx.drawPreparedEditorLabel(entry.label, entry.x, y, opacity)
        entry.frame = this.frame
        if (entity.type === 'timeScale' && entry.timeScale) {
            const { textWidth, direction } = entry.timeScale.layout
            drawTimeScaleGroupName(
                context,
                entity,
                highlighted,
                entry.x,
                y,
                textWidth,
                direction,
                opacity,
            )
        }
        return true
    }

    endFrame() {
        for (const [entity, entry] of this.entries)
            if (entry.frame !== this.frame) this.remove(entity, entry)
    }

    clear() {
        for (const [entity, entry] of this.entries) this.remove(entity, entry)
        this.context = undefined
        this.key = []
    }

    private create(context: EditorDrawContext, entity: AnnotationEntity): Entry | undefined {
        const { ctx, state, ups, fontFamily, scale, figureMiddle } = context
        const time = beatToTime(state.bpms, entity.beat)
        if (entity.type === 'bpm')
            return {
                label: ctx.prepareEditorLabel(
                    normalizeSvgText(formatBpm(entity.bpm)),
                    '#f0f',
                    fontFamily,
                    scale,
                    BPM_LABEL.size,
                    'start',
                    figureMiddle,
                    true,
                ),
                x: BPM_LABEL.lane,
                time,
                frame: this.frame,
            }
        const layout = timeScaleLabel(context, entity)
        const glyph = timeScaleEaseGlyph(context, entity, layout.x, time * ups, layout.direction)
        const prepared = ctx.prepareEaseGlyph(glyph.path, '#ff0', glyph.lineWidth)
        if (!prepared) return
        try {
            return {
                label: ctx.prepareEditorLabel(
                    normalizeSvgText(layout.text),
                    '#ff0',
                    fontFamily,
                    scale,
                    0.5,
                    layout.direction > 0 ? 'start' : 'end',
                    figureMiddle,
                    true,
                ),
                x: layout.x + glyph.width * layout.direction,
                time,
                frame: this.frame,
                timeScale: {
                    layout,
                    glyph: prepared,
                    x: glyph.x,
                    opacity: glyph.opacity,
                },
            }
        } catch (error) {
            ctx.releasePreparedEaseGlyph(prepared)
            throw error
        }
    }

    private remove(entity: AnnotationEntity, entry: Entry) {
        if (entry.timeScale) this.context?.ctx.releasePreparedEaseGlyph(entry.timeScale.glyph)
        this.entries.delete(entity)
    }
}
