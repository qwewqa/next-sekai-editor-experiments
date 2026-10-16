import { flickArrowPoints } from '../../flickArrow'
import type {
    NoteAtlasRegion,
    NoteBody,
    RenderSurface,
    RetainedNoteBodies,
    WebGLDrawContext,
} from '../../rendering/context'
import type { Entity } from '../../state/entities'
import { createSlideInfoLookup } from '../../state/entities/slides/lookup'
import type { NoteEntity } from '../../state/entities/slides/note'
import { getNoteVisualType, type NoteVisualType } from '../../state/entities/slides/visualType'
import { beatToTime } from '../../state/integrals/bpms'
import { noteStyleColors } from '../../utils/colors'
import { drawName, stageNameColor } from './names'
import { createNoteAtlas, type NoteAtlasSlot } from './noteAtlas'
import { strokeOffscreenAnchorBody } from './noteOutline'
import { drawKeyOf, type DrawStep } from './ordering'
import type { DrawSection } from './sections'
import type { EditorDrawContext } from './types'

// Lanes between a note's stage and group names and its middle.
const NAME_GAP = 0.1

const colors = {
    cyan: ['#aabfff', '#e6edff', '#8394f6'],
    green: ['#81f8cf', '#dafdf1', '#5ce29d'],
    red: ['#fec3dc', '#ffedf5', '#f89cc2'],
    yellow: ['#fed983', '#fffccc', '#fed84b'],
} as const

const traceColors = { green: '#5fefc2', red: '#fe9ccb', yellow: '#fddd86' }
const diamondColors = { green: '#abfbe3', red: '#ffd8f6', yellow: '#fff2c3' }

type Point = readonly [number, number]

const diamondPoints: readonly Point[] = [
    [-0.3, 0],
    [0, -0.3],
    [0.3, 0],
    [0, 0.15],
]

const diamondHighlightPoints: readonly Point[] = [
    [-0.25, 0],
    [0, -0.25],
    [0, 0.1],
]

const polygon = (ctx: WebGLDrawContext, points: readonly Point[]) => {
    ctx.beginPath()
    points.forEach(([x, y], i) => {
        if (i) ctx.lineTo(x, y)
        else ctx.moveTo(x, y)
    })
    ctx.closePath()
}

const roundedRect = (ctx: WebGLDrawContext, x: number, y: number, w: number, h: number) => {
    ctx.beginPath()
    // SVG does not paint rectangles with a negative width. Clamp each radius
    // independently, as SVG does for very narrow notes.
    if (w <= 0) return
    const rx = Math.min(0.1, w / 2)
    const ry = Math.min(0.1, h / 2)
    if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(x, y, w, h, { x: rx, y: ry })
        return
    }
    ctx.moveTo(x + rx, y)
    ctx.lineTo(x + w - rx, y)
    ctx.ellipse(x + w - rx, y + ry, rx, ry, 0, -Math.PI / 2, 0)
    ctx.lineTo(x + w, y + h - ry)
    ctx.ellipse(x + w - rx, y + h - ry, rx, ry, 0, 0, Math.PI / 2)
    ctx.lineTo(x + rx, y + h)
    ctx.ellipse(x + rx, y + h - ry, rx, ry, 0, Math.PI / 2, Math.PI)
    ctx.lineTo(x, y + ry)
    ctx.ellipse(x + rx, y + ry, rx, ry, 0, Math.PI, Math.PI * 1.5)
    ctx.closePath()
}

const artworkColors = (entity: NoteEntity, type: NoteVisualType) => {
    const { isCritical, flickDirection } = entity
    const palette = entity.noteStyle !== 'default' ? noteStyleColors[entity.noteStyle] : undefined
    const color = isCritical ? 'yellow' : flickDirection !== 'none' ? 'red' : 'green'
    return {
        body: palette ?? colors[type === 'single' && color === 'green' ? 'cyan' : color],
        flat: palette?.[2] ?? (type === 'damage' ? '#a50acc' : traceColors[color]),
        diamond: palette?.[1] ?? diamondColors[type === 'tick' && !isCritical ? 'green' : color],
        arrow: palette?.[2] ?? (isCritical ? '#ffc633' : '#ec7cb4'),
    }
}

const drawArtwork = (
    ctx: WebGLDrawContext,
    entity: NoteEntity,
    type: NoteVisualType,
    outline: boolean,
    scale: number,
    direct = false,
) => {
    const { size, flickDirection } = entity
    const fills = artworkColors(entity, type)
    const x = size > 0 ? 0 : -0.1
    const w = size > 0 ? size : 0.2
    ctx.lineWidth = 2 / scale
    ctx.lineJoin = 'miter'
    ctx.miterLimit = 4
    ctx.lineCap = 'butt'
    ctx.setLineDash([])

    if (type === 'anchor' || type === 'tick') {
        // A zero-width tick has no diamond; show the placeholder in its colour.
        if (type === 'tick' && size <= 0) {
            roundedRect(ctx, x, 0.15, w, 0.3)
            ctx.fillStyle = fills.diamond
            ctx.fill()
        }
        if (outline) {
            ctx.strokeStyle = '#fff'
            if (!direct || !strokeOffscreenAnchorBody(ctx, x, w)) {
                roundedRect(ctx, x, 0.15, w, 0.3)
                ctx.stroke()
            }
        }
    } else if (type === 'damage' || type === 'trace') {
        roundedRect(ctx, x, 0.15, w, 0.3)
        ctx.fillStyle = fills.flat
        ctx.fill()
    } else {
        const [outer, inner, dot] = fills.body
        roundedRect(ctx, x, 0, w, 0.6)
        ctx.fillStyle = outer
        ctx.fill()
        if (size > 0) {
            roundedRect(ctx, 0.1, 0.1, size - 0.2, 0.4)
            ctx.fillStyle = inner
            ctx.fill()
            ctx.fillStyle = dot
            ctx.fillRect(0.1, 0.225, 0.15, 0.15)
            ctx.fillRect(size - 0.25, 0.225, 0.15, 0.15)
        }
    }

    ctx.save()
    ctx.translate(size / 2, 0.3)
    if ((type === 'tick' || type === 'trace') && size > 0) {
        polygon(ctx, diamondPoints)
        ctx.fillStyle = fills.diamond
        ctx.fill()
        polygon(ctx, diamondHighlightPoints)
        ctx.fillStyle = '#fff'
        ctx.fill()
    }
    if (type !== 'anchor' && type !== 'tick' && type !== 'damage' && flickDirection !== 'none') {
        polygon(ctx, flickArrowPoints[flickDirection])
        ctx.fillStyle = fills.arrow
        ctx.fill()
        ctx.strokeStyle = '#fff'
        ctx.stroke()
    }
    ctx.restore()

    if (type !== 'anchor' && entity.isFake) {
        // A zero-width placeholder takes the X over its own box.
        const flat = size <= 0 && (type === 'tick' || type === 'damage' || type === 'trace')
        const [left, right] = size > 0 ? [0, size] : [x, x + w]
        const [top, bottom] = flat ? [0.15, 0.45] : [0, 0.6]
        ctx.strokeStyle = '#f44'
        ctx.beginPath()
        ctx.moveTo(left, top)
        ctx.lineTo(right, bottom)
        ctx.stroke()
        ctx.beginPath()
        ctx.moveTo(left, bottom)
        ctx.lineTo(right, top)
        ctx.stroke()
    }
}

type Sprite = {
    key: string
    slot: NoteAtlasSlot
    x: number
    y: number
    w: number
    h: number
    frame: number
}

type NotePosition = { left: number; y: number; size?: number }
type NoteArtwork = {
    entity: NoteEntity
    position: NotePosition | undefined
    type: NoteVisualType
    outline: boolean
}
type PreparedNote = NoteArtwork & {
    context: EditorDrawContext
    owner: object
    highlighted: boolean
    sprite: Sprite | undefined
    x: number
    y: number
}

type BodyRecord = { entity: Entity; sprite: Sprite; x: number; y: number; opacity: number }
type PreparedBody = PreparedNote & {
    sprite: Sprite & { slot: NoteAtlasSlot & { region: NoteAtlasRegion } }
}
type BodyRun = { body: RetainedNoteBodies; records: BodyRecord[]; frame: number }
type SectionBody = {
    section: DrawSection
    body: RetainedNoteBodies | undefined
    sprites: Sprite[]
    slides: Map<NoteEntity['slideId'], readonly [unknown, unknown]>
    outlineNotes: Set<NoteEntity>
    hovered: Set<Entity>
    active: boolean
    reused: boolean
    ups: number
    originTime: number
    /** Time and immutable atlas Y offset, interleaved in body order. */
    anchors: Float64Array
    ys: Float64Array
}
const maxSectionBodies = 512
const maxSectionSprites = 16384
const maxBodyRuns = 192
const maxBodySprites = 4096
const bodyRunKey = (step: DrawStep, pass: string) => {
    const { tier, isFull, beat } = drawKeyOf(step)
    return `${pass}:${tier}:${+isFull}:${Math.floor(beat / 16)}`
}

// The atlas caps page area separately: up to 16 MiB of resolved RGBA, plus MSAA
// attachments. Overflow scratch targets are separate. Large/unique notes draw directly.
const maxCachedSprites = 512
const maxSpritePixels = 1024 * 1024
const maxSpriteDimension = 4096

const artworkBounds = (
    { scale, pixelRatio }: EditorDrawContext,
    entity: NoteEntity,
    type: NoteVisualType,
) => {
    const density = scale * pixelRatio
    const hasArrow =
        type !== 'anchor' &&
        type !== 'tick' &&
        type !== 'damage' &&
        entity.flickDirection !== 'none'
    // Extra stroke space covers the mitered arrow tips and antialiasing.
    const padding = 4 / scale
    const l =
        Math.min(
            -0.1,
            entity.size,
            entity.size > 0 ? entity.size - 0.25 : 0,
            hasArrow ? entity.size / 2 - 1.2 : 0,
        ) - padding
    const r = Math.max(0.25, entity.size, hasArrow ? entity.size / 2 + 1.2 : 0) + padding
    const t = (hasArrow ? -0.9 : 0) - padding
    const b = 0.6 + padding
    const x = Math.floor(l * density) / density
    const y = Math.floor(t * density) / density
    return {
        density,
        x,
        y,
        width: Math.ceil((r - x) * density),
        height: Math.ceil((b - y) * density),
    }
}

const paintArtwork = (
    surface: RenderSurface,
    sx: number,
    sy: number,
    box: ReturnType<typeof artworkBounds>,
    entity: NoteEntity,
    type: NoteVisualType,
    outline: boolean,
    scale: number,
) => {
    const { density, x, y, width, height } = box
    const ctx = surface.getContext()
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    // Clear reused slots and their filtering gutter. Keep the original sprite's
    // clipping boundary so neighboring atlas artwork can never affect a note.
    ctx.clearRect(sx - 1, sy - 1, width + 2, height + 2)
    ctx.beginPath()
    ctx.rect(sx, sy, width, height)
    ctx.clip()
    ctx.setTransform(density, 0, 0, density, sx - x * density, sy - y * density)
    ctx.globalAlpha = 1
    drawArtwork(ctx, entity, type, outline, scale)
    ctx.restore()
}

const drawNoteNames = (
    context: EditorDrawContext,
    entity: NoteEntity,
    highlighted: boolean,
    x: number,
    y: number,
) => {
    const { state, recentlyActive } = context
    if (highlighted || recentlyActive) {
        const stage =
            context.showStageName && state.isDynamicStages && state.stages.get(entity.stageId)?.name
        const group =
            context.showGroupName &&
            entity.groupId !== context.defaultGroupId &&
            state.groups.get(entity.groupId)?.name
        // Side by side, the names keep 0.1 lane each from the middle.
        const gap = stage && group ? NAME_GAP : 0
        if (stage) {
            drawName(
                context,
                entity,
                highlighted,
                stage,
                x + entity.size / 2 - gap,
                y + 0.3,
                stageNameColor(context),
                0.4,
                group ? 'end' : 'center',
            )
        }
        if (group) {
            drawName(
                context,
                entity,
                highlighted,
                group,
                x + entity.size / 2 + gap,
                y + 0.3,
                '#0aa',
                0.4,
                stage ? 'start' : 'center',
            )
        }
    }
}

export const createNoteRenderer = () => {
    const sprites = new Map<string, Sprite>()
    const atlas = createNoteAtlas()
    let frame = 0
    let getSlideInfoLookup = createSlideInfoLookup()
    let ownerIds = new WeakMap<object, number>()
    let nextOwnerId = 0
    const scratch = new Map<object, RenderSurface>()
    // Only this frame's visible notes retain their resolved appearance. Reusing
    // it at draw time avoids a second composed-layout lookup and sprite key.
    const prepared = new Map<NoteEntity, PreparedNote>()
    const bodyRuns = new Map<string, BodyRun>()
    const sectionBodies = new Map<string, SectionBody>()
    const readySections = new Map<DrawSection, SectionBody>()
    let sectionPlan: readonly DrawSection[] | undefined
    let sectionContext: WebGLDrawContext | undefined
    let sectionDependencies: unknown[] = []
    let sectionSprites = 0
    const sectionStats = { captures: 0, replays: 0, declined: 0, ranges: 0, sprites: 0, touches: 0 }
    const removeSection = (key: string, entry: SectionBody) => {
        if (entry.body) sectionContext?.releaseNoteBodies(entry.body)
        sectionBodies.delete(key)
        readySections.delete(entry.section)
        sectionSprites -= entry.body?.count ?? 0
        sectionStats.ranges = sectionBodies.size
        sectionStats.sprites = sectionSprites
    }
    let bodyContext: WebGLDrawContext | undefined
    let bodySprites = 0
    let liveEntities: ReadonlySet<Entity> | undefined
    const bodyStats = { captures: 0, replays: 0, live: 0, ranges: 0, sprites: 0 }
    const removeBodyRun = (key: string, run: BodyRun) => {
        bodyContext?.releaseNoteBodies(run.body)
        bodyRuns.delete(key)
        bodySprites -= run.records.length
    }
    const preparedBody = (
        context: EditorDrawContext,
        step: DrawStep,
        hovered?: ReadonlySet<Entity>,
    ) => {
        if (step.entity.type !== 'note' || liveEntities?.has(step.entity)) return
        const ready = prepared.get(step.entity)
        if (
            ready?.context !== context ||
            ready.owner !== context.ctx.resourceOwner ||
            ready.highlighted !== (step.highlighted || !!hovered?.has(step.entity)) ||
            !ready.sprite?.slot.region ||
            !ready.sprite.slot.valid()
        )
            return
        return ready as PreparedBody
    }

    const resolveArtwork = (
        context: EditorDrawContext,
        entity: NoteEntity,
        highlighted: boolean,
        position?: NotePosition,
    ): NoteArtwork => {
        if (!position && context.composed) {
            position = {
                ...context.composed.notePosition(entity, entity.beat, {
                    slideInfos: context.slideInfos?.get(entity.slideId),
                }),
                y: beatToTime(context.state.bpms, entity.beat) * context.ups - 0.3,
            }
        }
        if (position?.size !== undefined && position.size !== entity.size)
            entity = { ...entity, size: position.size, useInfoOf: entity.useInfoOf ?? entity }
        const infos =
            context.state.store.slides.info.get(entity.slideId) ??
            context.slideInfos?.get(entity.slideId)
        const lookup = infos && getSlideInfoLookup(infos)
        const type = getNoteVisualType(entity, infos, lookup)
        const outline =
            (type === 'anchor' || type === 'tick') && (highlighted || context.recentlyActive)
        return { entity, position, type, outline }
    }

    const getScratch = (ctx: WebGLDrawContext, width: number, height: number) => {
        for (const [owner, surface] of scratch) {
            const cached = surface.getContext()
            if (!cached.isContextLost() && cached.resourceOwner === owner) continue
            surface.dispose()
            scratch.delete(owner)
        }
        let surface = scratch.get(ctx.resourceOwner)
        if (!surface) {
            surface = ctx.createSurface(width, height)
            scratch.set(ctx.resourceOwner, surface)
        } else if (surface.width < width || surface.height < height) {
            const w = Math.max(surface.width, width)
            const h = Math.max(surface.height, height)
            const fits = w * h <= maxSpritePixels
            surface.width = fits ? w : width
            surface.height = fits ? h : height
        }
        return surface
    }

    const release = (sprite: Sprite) => {
        sprite.slot.release()
    }

    const getSprite = (
        context: EditorDrawContext,
        entity: NoteEntity,
        type: NoteVisualType,
        outline: boolean,
    ) => {
        const { scale, pixelRatio } = context
        let ownerId = ownerIds.get(context.ctx.resourceOwner)
        if (ownerId === undefined) {
            ownerId = nextOwnerId++
            ownerIds.set(context.ctx.resourceOwner, ownerId)
        }
        const key = `${ownerId}:${type === 'tail' ? 'head' : type}:${entity.size}:${entity.noteStyle}:${+entity.isCritical}:${entity.flickDirection}:${+entity.isFake}:${+outline}:${scale}:${pixelRatio}`
        const cached = sprites.get(key)
        if (cached?.slot.valid()) {
            sprites.delete(key)
            sprites.set(key, cached)
            cached.frame = frame
            return cached
        }
        if (cached) {
            sprites.delete(key)
            release(cached)
        }

        const box = artworkBounds(context, entity, type)
        const { density, x, y, width, height } = box
        const pixels = width * height
        const dimensionLimit = Math.min(maxSpriteDimension, context.ctx.maxSurfaceSize)
        if (pixels > maxSpritePixels || width > dimensionLimit || height > dimensionLimit) {
            return
        }

        // A dense view may contain more distinct widths than fit in the cache.
        // Evicting artwork already used in this frame would repeat every miss
        // on every subsequent frame. Retain that working set and draw overflow
        // directly; an ordinary scroll can still replace unused older sprites.
        let slot: NoteAtlasSlot | undefined
        while (!slot) {
            if (sprites.size < maxCachedSprites) slot = atlas.allocate(context.ctx, width, height)
            if (slot) break
            const oldest = sprites.entries().next().value
            if (!oldest || oldest[1].frame === frame) return
            sprites.delete(oldest[0])
            release(oldest[1])
        }

        paintArtwork(slot.surface, slot.x, slot.y, box, entity, type, outline, scale)
        const sprite = { key, slot, x, y, w: width / density, h: height / density, frame }
        sprites.set(key, sprite)
        return sprite
    }

    const sectionHover = (
        entry: Pick<SectionBody, 'outlineNotes'>,
        hovered?: ReadonlySet<Entity>,
    ) =>
        new Set(
            [...(hovered ?? [])].filter(
                (entity) => entity.type === 'note' && entry.outlineNotes.has(entity),
            ),
        )

    const buildSection = (
        context: EditorDrawContext,
        section: DrawSection,
        activeKeys: ReadonlySet<string>,
        hovered?: ReadonlySet<Entity>,
    ): SectionBody | undefined => {
        const bodies: NoteBody[] = []
        const anchors: number[] = []
        const artwork = new Set<Sprite>()
        const slides: SectionBody['slides'] = new Map()
        const outlineNotes = new Set<NoteEntity>()
        for (const step of section.steps) {
            if (step.entity.type !== 'note') return
            const entity = step.entity
            if (step.opacity <= 0) continue
            if (!slides.has(entity.slideId))
                slides.set(entity.slideId, [
                    context.state.store.slides.info.get(entity.slideId),
                    context.slideInfos?.get(entity.slideId),
                ])
            const highlighted = step.highlighted || !!hovered?.has(entity)
            if (entity.noteType === 'anchor') {
                if (!step.highlighted) outlineNotes.add(entity)
                if (!highlighted && !context.recentlyActive) continue
            }
            const resolved = resolveArtwork(context, entity, highlighted)
            if ((resolved.type === 'anchor' || resolved.type === 'tick') && !step.highlighted)
                outlineNotes.add(entity)
            if (resolved.type === 'anchor' && !resolved.outline) continue
            const sprite = getSprite(context, resolved.entity, resolved.type, resolved.outline)
            if (!sprite?.slot.region) return
            artwork.add(sprite)
            const time = beatToTime(context.state.bpms, entity.beat)
            bodies.push({
                region: sprite.slot.region,
                x: (resolved.position?.left ?? resolved.entity.left) + sprite.x,
                y: (resolved.position?.y ?? time * context.ups - 0.3) + sprite.y,
                width: sprite.w,
                height: sprite.h,
                alpha: step.opacity,
            })
            anchors.push(time, sprite.y)
            if (bodies.length > maxSectionSprites) return
        }
        // Keep one variant per section key. Reclaim inactive sections first;
        // active groups and atlas artwork remain protected for this presentation.
        while (
            sectionBodies.size >= maxSectionBodies ||
            sectionSprites + bodies.length > maxSectionSprites
        ) {
            const oldest = [...sectionBodies].find(([key]) => !activeKeys.has(key))
            if (!oldest) return
            removeSection(...oldest)
        }
        const originTime = beatToTime(context.state.bpms, section.minBeat)
        const body = bodies.length
            ? context.ctx.createNoteBodies(bodies, originTime * context.ups)
            : undefined
        if (bodies.length && !body) return
        const entry: SectionBody = {
            section,
            body,
            sprites: [...artwork],
            slides,
            outlineNotes,
            active: context.recentlyActive && !!outlineNotes.size,
            hovered: new Set(),
            reused: false,
            ups: context.ups,
            originTime,
            anchors: new Float64Array(anchors),
            ys: Float64Array.from(bodies, ({ y }) => y),
        }
        if (!entry.active) entry.hovered = sectionHover(entry, hovered)
        sectionBodies.set(section.key, entry)
        sectionSprites += body?.count ?? 0
        sectionStats.captures++
        return entry
    }

    return {
        bodyStats,
        sectionStats,
        beginFrame(timestamp: number) {
            frame = timestamp
            prepared.clear()
            readySections.clear()
        },
        /** Complete atlas work before any chart readers; warm sections touch only unique artwork. */
        prepareSections(
            context: EditorDrawContext,
            allSections: readonly DrawSection[],
            activeSections: readonly DrawSection[],
            hovered?: ReadonlySet<Entity>,
        ): ReadonlySet<DrawSection> {
            readySections.clear()
            const { ctx } = context
            const matrix = ctx.getTransform()
            const dependencies = [
                ctx.resourceOwner,
                context.scale,
                context.pixelRatio,
                context.state.bpms,
                !!context.composed,
                context.composed?.stages,
                matrix.a,
                matrix.b,
                matrix.c,
                matrix.d,
                ctx.globalAlpha,
                ctx.imageSmoothingEnabled,
            ]
            if (
                sectionContext !== ctx ||
                dependencies.some((value, index) => value !== sectionDependencies[index])
            ) {
                for (const [key, entry] of sectionBodies) removeSection(key, entry)
                sectionContext = ctx
                sectionDependencies = dependencies
            }
            if (sectionPlan !== allSections) {
                const current = new Map(allSections.map((section) => [section.key, section]))
                for (const [key, entry] of sectionBodies)
                    if (current.get(key) !== entry.section) removeSection(key, entry)
                sectionPlan = allSections
            }
            const activeKeys = new Set(activeSections.map(({ key }) => key))
            // Protect all reusable artwork before a cold section allocates and evicts slots.
            for (const section of activeSections) {
                if (section.live || section.steps[0]?.entity.type !== 'note') continue
                const entry = sectionBodies.get(section.key)
                if (!entry) continue
                const active = context.recentlyActive && !!entry.outlineNotes.size
                const currentHover = active ? new Set<Entity>() : sectionHover(entry, hovered)
                const valid =
                    entry.section === section &&
                    !entry.body?.released &&
                    entry.active === active &&
                    currentHover.size === entry.hovered.size &&
                    [...currentHover].every((entity) => entry.hovered.has(entity)) &&
                    [...entry.slides].every(
                        ([id, [info, extra]]) =>
                            info === context.state.store.slides.info.get(id) &&
                            extra === context.slideInfos?.get(id),
                    ) &&
                    entry.sprites.every(
                        (sprite) => sprites.get(sprite.key) === sprite && sprite.slot.valid(),
                    )
                if (!valid) {
                    removeSection(section.key, entry)
                    continue
                }
                if (entry.ups !== context.ups) {
                    for (let index = 0; index < entry.ys.length; index++)
                        entry.ys[index] =
                            (entry.anchors[index * 2] ?? NaN) * context.ups -
                            0.3 +
                            (entry.anchors[index * 2 + 1] ?? NaN)
                    if (
                        entry.body &&
                        !ctx.updateNoteBodyPositions(
                            entry.body,
                            entry.ys,
                            entry.originTime * context.ups,
                        )
                    ) {
                        removeSection(section.key, entry)
                        continue
                    }
                    entry.ups = context.ups
                }
                for (const sprite of entry.sprites) {
                    if (sprite.frame === frame) continue
                    sprites.delete(sprite.key)
                    sprites.set(sprite.key, sprite)
                    sprite.frame = frame
                    sectionStats.touches++
                }
                sectionBodies.delete(section.key)
                sectionBodies.set(section.key, entry)
                entry.reused = true
                readySections.set(section, entry)
            }
            if (context.scale > 0 && context.pixelRatio > 0)
                for (const section of activeSections) {
                    if (
                        section.live ||
                        section.steps[0]?.entity.type !== 'note' ||
                        readySections.has(section)
                    )
                        continue
                    const entry = buildSection(context, section, activeKeys, hovered)
                    if (entry) readySections.set(section, entry)
                    else sectionStats.declined++
                }
            sectionStats.ranges = sectionBodies.size
            sectionStats.sprites = sectionSprites
            return new Set(readySections.keys())
        },
        /** Only bodies are retained. The caller queues names from its exact visible traversal. */
        drawSection(context: EditorDrawContext, section: DrawSection): boolean {
            const entry = readySections.get(section)
            if (!entry || sectionContext !== context.ctx) return false
            if (entry.body && !context.ctx.drawNoteBodies(entry.body)) {
                removeSection(section.key, entry)
                return false
            }
            if (entry.reused) sectionStats.replays++
            return true
        },
        drawVisibleNames(
            context: EditorDrawContext,
            steps: readonly DrawStep[],
            hovered?: ReadonlySet<Entity>,
        ) {
            if (
                (!context.showStageName && !context.showGroupName) ||
                context.scale <= 0 ||
                context.pixelRatio <= 0
            )
                return
            const { ctx } = context
            const alpha = ctx.globalAlpha
            ctx.save()
            try {
                for (const step of steps) {
                    if (step.entity.type !== 'note' || step.opacity <= 0) continue
                    const highlighted = step.highlighted || !!hovered?.has(step.entity)
                    if (!highlighted && !context.recentlyActive) continue
                    const ready = prepared.get(step.entity)
                    const artwork =
                        ready?.context === context &&
                        ready.owner === ctx.resourceOwner &&
                        ready.highlighted === highlighted
                            ? ready
                            : resolveArtwork(context, step.entity, highlighted)
                    if (artwork.type === 'anchor' && !artwork.outline) continue
                    ctx.globalAlpha = alpha * step.opacity
                    drawNoteNames(
                        context,
                        artwork.entity,
                        highlighted,
                        artwork.position?.left ?? artwork.entity.left,
                        artwork.position?.y ??
                            beatToTime(context.state.bpms, artwork.entity.beat) * context.ups - 0.3,
                    )
                }
            } finally {
                ctx.restore()
            }
        },
        prepare(context: EditorDrawContext, entity: NoteEntity, highlighted: boolean, opacity = 1) {
            if (opacity <= 0 || context.scale <= 0 || context.pixelRatio <= 0) return
            // Most notes in dense charts are hidden anchors. Their explicit
            // type takes priority over slide roles and composed positioning.
            if (entity.noteType === 'anchor' && !highlighted && !context.recentlyActive) return
            const artwork = resolveArtwork(context, entity, highlighted)
            const { type, outline } = artwork
            prepared.set(entity, {
                ...artwork,
                context,
                owner: context.ctx.resourceOwner,
                highlighted,
                x: artwork.position?.left ?? artwork.entity.left,
                y:
                    artwork.position?.y ??
                    beatToTime(context.state.bpms, artwork.entity.beat) * context.ups - 0.3,
                sprite:
                    type === 'anchor' && !outline
                        ? undefined
                        : getSprite(context, artwork.entity, type, outline),
            })
        },
        prepareRuns(
            context: EditorDrawContext,
            steps: DrawStep[],
            raisedAt: number,
            live?: ReadonlySet<Entity>,
        ) {
            if (bodyContext !== context.ctx) {
                for (const [key, run] of bodyRuns) removeBodyRun(key, run)
                bodyContext = context.ctx
            }
            liveEntities = live
            const counts = new Map<string, number>()
            for (let index = 0; index < steps.length; index++) {
                const step = steps[index]
                if (step?.entity.type !== 'note' || live?.has(step.entity)) continue
                const key = bodyRunKey(step, index < raisedAt ? 'normal' : 'raised')
                counts.set(key, (counts.get(key) ?? 0) + 1)
            }
            // Free the preceding viewport before creating new groups. No atlas
            // slot is pinned: the all-visible artwork prepass protects this frame.
            for (const [key, run] of bodyRuns)
                if (counts.get(key) !== run.records.length) removeBodyRun(key, run)
        },
        drawRun(
            context: EditorDrawContext,
            steps: DrawStep[],
            from: number,
            to: number,
            pass: string,
            hovered: ReadonlySet<Entity> | undefined,
            draw: (context: EditorDrawContext, step: DrawStep) => void,
        ) {
            const first = steps[from]
            if (!first) return
            const { ctx } = context
            const key = bodyRunKey(first, pass)
            let run = bodyRuns.get(key)
            let valid =
                !!context.names && !!run && !run.body.released && run.records.length === to - from
            for (let index = from; valid && index < to; index++) {
                const step = steps[index]
                const old = run?.records[index - from]
                const ready = step && preparedBody(context, step, hovered)
                valid = !!(
                    step &&
                    old &&
                    ready &&
                    old.entity === step.entity &&
                    old.sprite === ready.sprite &&
                    old.x === ready.x &&
                    old.y === ready.y &&
                    old.opacity === step.opacity
                )
            }
            if (!valid && run) {
                removeBodyRun(key, run)
                run = undefined
            }
            if (
                !run &&
                context.names &&
                typeof ctx.createNoteBodies === 'function' &&
                bodyRuns.size < maxBodyRuns &&
                bodySprites + to - from <= maxBodySprites
            ) {
                const records: BodyRecord[] = []
                const bodies: NoteBody[] = []
                for (let index = from; index < to; index++) {
                    const step = steps[index]
                    const ready = step && preparedBody(context, step, hovered)
                    if (!step || !ready) break
                    const { sprite, x, y } = ready
                    records.push({ entity: step.entity, sprite, x, y, opacity: step.opacity })
                    bodies.push({
                        region: sprite.slot.region,
                        x: x + sprite.x,
                        y: y + sprite.y,
                        width: sprite.w,
                        height: sprite.h,
                        alpha: step.opacity,
                    })
                }
                if (records.length === to - from) {
                    const origin =
                        beatToTime(context.state.bpms, Math.floor(first.entity.beat / 16) * 16) *
                        context.ups
                    const body = ctx.createNoteBodies(bodies, origin)
                    if (body) {
                        run = { body, records, frame }
                        bodyRuns.set(key, run)
                        bodySprites += records.length
                        bodyStats.captures++
                    }
                }
            }
            if (run && ctx.drawNoteBodies(run.body)) {
                if (valid) bodyStats.replays++
                run.frame = frame
                // Only bodies are retained. Names use current state, visibility,
                // activity and hover, in the original painter-order traversal.
                const alpha = ctx.globalAlpha
                for (let index = from; index < to; index++) {
                    const step = steps[index]
                    const ready = step && preparedBody(context, step, hovered)
                    if (!step || !ready) continue
                    ctx.globalAlpha = alpha * step.opacity
                    drawNoteNames(context, ready.entity, ready.highlighted, ready.x, ready.y)
                }
                ctx.globalAlpha = alpha
                return
            }
            if (run) removeBodyRun(key, run)
            bodyStats.live += to - from
            for (let index = from; index < to; index++) {
                const step = steps[index]
                if (step) draw(context, step)
            }
        },
        endFrame() {
            for (const [key, run] of bodyRuns) if (run.frame !== frame) removeBodyRun(key, run)
            bodyStats.ranges = bodyRuns.size
            bodyStats.sprites = bodySprites
        },
        draw(
            context: EditorDrawContext,
            entity: NoteEntity,
            highlighted: boolean,
            opacity = 1,
            position?: NotePosition,
            drawNames = true,
        ) {
            const { ctx, state, scale, recentlyActive } = context
            if (opacity <= 0 || scale <= 0 || context.pixelRatio <= 0) return
            if (entity.noteType === 'anchor' && !highlighted && !recentlyActive) return
            const candidate = position ? undefined : prepared.get(entity)
            const ready =
                candidate?.context === context &&
                candidate.owner === ctx.resourceOwner &&
                candidate.highlighted === highlighted
                    ? candidate
                    : undefined
            const artwork = ready ?? resolveArtwork(context, entity, highlighted, position)
            const { type, outline } = artwork
            entity = artwork.entity
            position = artwork.position
            if (type === 'anchor' && !outline) return
            const x = position?.left ?? entity.left
            const y = position?.y ?? beatToTime(state.bpms, entity.beat) * context.ups - 0.3
            ctx.save()
            ctx.globalAlpha *= opacity
            // A miss stays a miss for this frame: overflow still draws directly.
            // Context restoration or explicit cache clearing can invalidate a slot.
            const sprite =
                ready && (!ready.sprite || ready.sprite.slot.valid())
                    ? ready.sprite
                    : getSprite(context, entity, type, outline)
            if (sprite) {
                if (sprite.slot.region) {
                    ctx.drawNoteAtlasRegion(
                        sprite.slot.region,
                        x + sprite.x,
                        y + sprite.y,
                        sprite.w,
                        sprite.h,
                    )
                } else {
                    ctx.drawImage(
                        sprite.slot.surface,
                        sprite.slot.x,
                        sprite.slot.y,
                        sprite.slot.width,
                        sprite.slot.height,
                        x + sprite.x,
                        y + sprite.y,
                        sprite.w,
                        sprite.h,
                    )
                }
            } else {
                // Faded artwork composites once even when its cache is full. A small
                // reusable target handles ordinary overflow; unusually large notes
                // use a layer bounded to their artwork and the viewport.
                const box = artworkBounds(context, entity, type)
                if (
                    ctx.globalAlpha !== 1 &&
                    box.width * box.height <= maxSpritePixels &&
                    box.width <= maxSpriteDimension &&
                    box.height <= maxSpriteDimension &&
                    box.width <= ctx.maxSurfaceSize &&
                    box.height <= ctx.maxSurfaceSize
                ) {
                    const surface = getScratch(ctx, box.width, box.height)
                    paintArtwork(surface, 0, 0, box, entity, type, outline, scale)
                    ctx.drawImage(
                        surface,
                        0,
                        0,
                        box.width,
                        box.height,
                        x + box.x,
                        y + box.y,
                        box.width / box.density,
                        box.height / box.density,
                    )
                } else {
                    if (ctx.globalAlpha === 1) ctx.save()
                    else {
                        ctx.saveLayer(
                            ctx.globalAlpha,
                            x + box.x,
                            y + box.y,
                            box.width / box.density,
                            box.height / box.density,
                        )
                        ctx.globalAlpha = 1
                    }
                    ctx.translate(x, y)
                    drawArtwork(ctx, entity, type, outline, scale, true)
                    ctx.restore()
                }
            }

            if (drawNames) drawNoteNames(context, entity, highlighted, x, y)
            ctx.restore()
        },
        clear() {
            for (const [key, entry] of sectionBodies) removeSection(key, entry)
            readySections.clear()
            sectionPlan = undefined
            sectionContext = undefined
            sectionDependencies = []
            for (const [key, run] of bodyRuns) removeBodyRun(key, run)
            bodyContext = undefined
            liveEntities = undefined
            prepared.clear()
            for (const sprite of sprites.values()) release(sprite)
            sprites.clear()
            atlas.clear()
            for (const surface of scratch.values()) surface.dispose()
            scratch.clear()
            getSlideInfoLookup = createSlideInfoLookup()
            ownerIds = new WeakMap()
            nextOwnerId = 0
        },
    }
}
