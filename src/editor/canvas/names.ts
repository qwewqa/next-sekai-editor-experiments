import type { WebGLDrawContext } from '../../rendering/context'
import type { Entity } from '../../state/entities'
import { NameLayout, type NamePlacement } from './nameLayout'
import { drawText, measureCachedText, normalizeSvgText } from './text'
import type { EditorDrawContext } from './types'

type NameRequest = {
    owner: Entity
    highlighted: boolean
    text: string
    x: number
    y: number
    color: string
    size: number
    align: CanvasTextAlign
    alpha: number
}

type PlacedName = Omit<NameRequest, 'owner' | 'highlighted' | 'alpha'>

/** A frame's stage and group names, drawn after every object. */
export type NameLayer = {
    names: NameRequest[]
}

export const createNameLayer = (): NameLayer => ({ names: [] })

// Context ownership keeps independent chart/elevation panes from influencing
// one another. The layout retains only names visible in its most recent frame.
const layouts = new WeakMap<WebGLDrawContext, NameLayout>()

const nameBox = (name: PlacedName, width: number) => {
    const l =
        name.align === 'center'
            ? name.x - width / 2
            : name.align === 'end' || name.align === 'right'
              ? name.x - width
              : name.x
    return { l, r: l + width, t: name.y - name.size / 2, b: name.y + name.size / 2 }
}

// Whole-name sprites preserve browser shaping and apply opacity once to fill and outline.
const namePen = (context: EditorDrawContext) => {
    const { ctx, nameSprites } = context
    const scene = nameSprites && ctx.getTransform()
    return {
        begin() {
            ctx.save()
            if (scene) ctx.setTransform(1, 0, 0, 1, 0, 0)
        },
        end() {
            ctx.restore()
        },
        text(name: PlacedName, color: string) {
            const { text, x, y, size, align } = name
            if (!scene) {
                drawText(context, text, x, y, color, size, align)
                return
            }
            if (
                nameSprites.draw(
                    context,
                    scene,
                    text,
                    x,
                    y,
                    color,
                    size,
                    align,
                    context.fontMiddle,
                    context.nameContrast,
                )
            )
                return
            // Too large for a sprite.
            ctx.save()
            ctx.setTransform(scene)
            drawText(context, text, x, y, color, size, align)
            ctx.restore()
        },
    }
}

const ellipsis = '…'
const graphemes = new Intl.Segmenter()

// Segmentation only depends on normalized text, not font, zoom or pane bounds.
const nameParts = new Map<string, readonly string[]>()
const maxNameParts = 128
const maxNamePartUnits = 16_384
const maxCachedNameLength = 1_024
let namePartUnits = 0

const segmentName = (text: string): readonly string[] => {
    const normalized = normalizeSvgText(text)
    const cached = nameParts.get(normalized)
    if (cached) return cached
    const parts = [...graphemes.segment(normalized)].map(({ segment }) => segment)
    if (normalized.length > maxCachedNameLength) return parts
    // Oldest entries go first; bound both array count and retained text.
    for (const [old] of nameParts) {
        if (nameParts.size < maxNameParts && namePartUnits + normalized.length <= maxNamePartUnits)
            break
        nameParts.delete(old)
        namePartUnits -= old.length
    }
    nameParts.set(normalized, parts)
    namePartUnits += normalized.length
    return parts
}

/** Cuts a name at the pane's side with an ellipsis; none when even that has no room. */
const fitName = <T extends PlacedName>(context: EditorDrawContext, name: T): T | undefined => {
    const box = nameBox(name, measureCachedText(context, name.text, name.size))
    const { l, r } = context.bounds
    if (box.l >= l && box.r <= r) return name
    // Keep the start unless only the start runs past.
    const keepStart = box.r > r
    const from = Math.max(box.l, l)
    const room = (keepStart ? r : box.r) - from
    const parts = segmentName(name.text)
    const cut = (count: number) =>
        keepStart
            ? parts.slice(0, count).join('') + ellipsis
            : ellipsis + parts.slice(parts.length - count).join('')
    const fits = (count: number) => measureCachedText(context, cut(count), name.size) <= room
    if (!fits(0)) return
    let low = 0
    let high = parts.length - 1
    while (low < high) {
        const mid = Math.ceil((low + high) / 2)
        if (fits(mid)) low = mid
        else high = mid - 1
    }
    return keepStart
        ? { ...name, text: cut(low), x: from, align: 'left' }
        : { ...name, text: cut(low), x: box.r, align: 'right' }
}

// The contrast option pairs a brighter stage colour with a narrow black outline.
export const stageNameColor = (context: EditorDrawContext) =>
    context.nameContrast ? '#f6f' : '#a0a'

/** Draws a name now, or queues it when the frame places names. */
export const drawName = (
    context: EditorDrawContext,
    owner: Entity,
    highlighted: boolean,
    text: string,
    x: number,
    y: number,
    color: string,
    size = 0.4,
    align: CanvasTextAlign = 'center',
) => {
    if (!context.names) {
        const name = fitName(context, { text, x, y, color, size, align })
        if (!name) return
        const pen = namePen(context)
        pen.begin()
        pen.text(name, color)
        pen.end()
        return
    }
    const alpha = context.ctx.globalAlpha
    context.names.names.push({ owner, highlighted, text, x, y, color, size, align, alpha })
}

/** Draws the queued names, selected and hovered ones last so they lie on top. */
export const placeNames = (context: EditorDrawContext, { names }: NameLayer) => {
    const { ctx } = context
    const placed: (NamePlacement & { name: NameRequest })[] = []
    for (const queued of names) {
        if (queued.alpha === 0) continue
        const name = fitName(context, queued)
        if (!name) continue
        const box = nameBox(name, measureCachedText(context, name.text, name.size))
        if (box.b <= context.bounds.t || box.t >= context.bounds.b || box.r <= box.l) continue
        // Include the visible half-CSS-pixel outline in collision placement.
        const pad = context.nameContrast ? 0.5 / context.scale : 0
        placed.push({
            owner: queued.owner,
            // Callers queue at most one stage and one group name per owner.
            // Colour/alignment distinguish the roles; fitting must not change identity.
            key: `${queued.color}:${queued.align}:${queued.text}`,
            highlighted: queued.highlighted,
            box: { l: box.l - pad, r: box.r + pad, t: box.t - pad, b: box.b + pad },
            name,
        })
    }
    let layout = layouts.get(ctx)
    if (!layout) layouts.set(ctx, (layout = new NameLayout()))
    const visible = layout.place(placed)
    const pen = namePen(context)
    pen.begin()
    for (const highlighted of [false, true]) {
        for (const placedName of placed) {
            if (placedName.highlighted !== highlighted || !visible.has(placedName)) continue
            const { name } = placedName
            ctx.globalAlpha = name.alpha
            pen.text(name, name.color)
        }
    }
    pen.end()
}
