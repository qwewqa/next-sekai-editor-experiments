<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, useTemplateRef, watchEffect } from 'vue'
import { beats, keys, times } from '..'
import { isAppActive } from '../../activity'
import { state } from '../../history'
import { defaultGroupId } from '../../history/groups'
import { cullAllEntities } from '../../history/store'
import { isPlaying } from '../../player'
import { previewEdit } from '../../preview/edit'
import { settings } from '../../settings'
import type { Entity } from '../../state/entities'
import { BPM_LABEL } from '../../state/entities/bpm'
import type { NoteEntity } from '../../state/entities/slides/note'
import { beatToTime, timeToBeat } from '../../state/integrals/bpms'
import { computedArray } from '../../utils/array'
import { activateEditorNavigation, controlsForNavigation, useCanvasCursor } from '../controls'
import { isDragging } from '../controls/gestures/recognizers/drag'
import { computedVisibleEntities, isEntityInBeatRange } from '../entities/visibility'
import { culledEntities, selectedEntitySet, visibleSelectedEntities } from '../entities/visible'
import { entityScopeVisibility } from '../scopeRules'
import {
    drawnGrid,
    isScenePreview,
    previewSlides,
    sceneCounterparts,
    sceneState,
    toCommittedEntity,
    toSceneEntity,
} from '../sceneState'
import { isPreviewScrubbing } from '../player'
import { scopeLookup } from '../scope'
import { bgmOffsetDelta } from '../tools/offset'
import { tool, tools } from '../tools'
import { pasteGhostBase, pasteGhostInfos, pasteGhostState } from '../tools/paste'
import { isVisible } from '../tools/utils'
import { hoveredEntities, isViewRecentlyActive, view, viewBox } from '../view'
import OffscreenNoteIndicators from '../OffscreenNoteIndicators.vue'
import { hitOffscreenIndicator, useOffscreenIndicators } from '../offscreenIndicators'
import {
    groupOffscreenNotes,
    isSameOffscreenGroups,
    OFFSCREEN_REACH,
    offscreenSlotNear,
    RANGE_LABEL_HEIGHT,
    type OffscreenNoteGroup,
} from '../offscreenNotes'
import {
    edgeLabelBoxes,
    hoverLabelCenter,
    lineSpanAt,
    type LineSpan,
    type SideBoxes,
} from '../edgeLabels'
import { createConnectorRenderer } from './connectors'
import { drawEvent, drawEventInfinities } from './events'
import {
    bpmLabelYs,
    coveredLabelYs,
    drawGrid,
    gridLabels,
    isNearLabel,
    timeScaleEdgeLabelYs,
} from './grid'
import { chartBackground } from './nameColors'
import { createLabelSprites } from './labelSprites'
import { createNameLayer, placeNames } from './names'
import { createNoteRenderer } from './notes'
import { orderEntities, toDrawSteps, type DrawStep } from './ordering'
import { createFrameScheduler, prepareSurface } from './surface'
import { clearTextWidths, FIGURE_MIDDLE, measureFigureMiddle, measureTextMiddle } from './text'
import type { EdgeLabelYs, EditorDrawContext } from './types'
import { createWaveformRenderer } from './waveform'
import { createComposedLayout } from '../composed'
import { createStageSurface, SUSTAINED_MS } from './stageSurface'

const container = useTemplateRef('container')
const { cursor, cursorListeners } = useCanvasCursor(() => undefined)
const controlListeners = { ...controlsForNavigation(() => undefined), ...cursorListeners }
const chartCanvas = useTemplateRef<HTMLCanvasElement>('chart')
const overlayCanvas = useTemplateRef<HTMLCanvasElement>('overlay')
const pixelRatio = ref(devicePixelRatio || 1)
const fontFamily = ref('sans-serif')
const fontMiddle = ref(0.25)
const figureMiddle = ref(FIGURE_MIDDLE)
const redrawVersion = ref(0)
const waveformVersion = ref(0)
// Bumped once shifted stage pixels have held still for a motion's gap, to redraw them exactly.
const stageSettle = ref(0)
let stageSettleTimer: ReturnType<typeof setTimeout> | undefined
const chartFrame = createFrameScheduler()
const overlayFrame = createFrameScheduler()
const notes = createNoteRenderer()
const nameSprites = createLabelSprites()
const connectors = createConnectorRenderer()
const stages = createStageSurface()
const composed = computed(() =>
    view.layout === 'composed' && sceneState.value.isDynamicStages
        ? createComposedLayout(sceneState.value)
        : undefined,
)
const waveform = createWaveformRenderer(() => waveformVersion.value++)
let creatingCanvas: HTMLCanvasElement | undefined

// The beats in the pane and `padding` px past it.
const beatRange = (padding: number) => {
    const bpms = sceneState.value.bpms
    return {
        min: timeToBeat(bpms, Math.max(0, times.value.min - padding / settings.pps)),
        max: timeToBeat(bpms, times.value.max + padding / settings.pps),
    }
}
const artRange = computed(() => beatRange(1.25 * (view.w / viewBox.value.w) + 4))
const artEntities = computedVisibleEntities(
    () => culledEntities.value,
    () => artRange.value,
)
// Slides a drag changes beyond its ghosts are drawn as they drop; only then is the range read.
const showEntities = (shown: Entity[], range: () => { min: number; max: number }) => {
    const preview = previewSlides.value
    if (!preview) return { entities: shown, selected: selectedEntitySet.value }
    const { min, max } = range()
    // In the drop's store order, which settles same-beat ties; the source's own entities stay in place.
    const source = shown.filter((entity) => !preview.includes(entity))
    const indices = new Map(source.map((entity, index) => [entity, index]))
    const entities: Entity[] = []
    let next = 0
    for (const entity of cullAllEntities(keys.value.min, keys.value.max, preview.state.store)) {
        if (preview.entities.has(entity)) {
            if (isEntityInBeatRange(entity, min, max)) entities.push(entity)
            continue
        }
        const index = indices.get(entity)
        if (index === undefined || index < next) continue
        entities.push(...source.slice(next, index + 1))
        next = index + 1
    }
    entities.push(...source.slice(next))
    return {
        entities,
        selected: new Set([
            ...selectedEntitySet.value,
            ...preview.state.selectedEntities.filter(preview.includes),
        ]),
    }
}
const shownEntities = computed(() => showEntities(artEntities.value, () => artRange.value))
const visibility = () => ({
    scope: scopeLookup.value,
    visibilities: view.visibilities,
    showOtherObjects: settings.showOtherObjects,
})
const orderedEntities = computed(() =>
    orderEntities(shownEntities.value.entities, shownEntities.value.selected, visibility()),
)
const drawSteps = computed(() => toDrawSteps(orderedEntities.value))
// Hovered objects are committed ones; a previewed scene draws their counterparts.
const sceneHovered = computed(() =>
    sceneCounterparts.value
        ? hoveredEntities.value.map((entity) => toSceneEntity(entity))
        : hoveredEntities.value,
)
const hoveredSet = computed(() => new Set(sceneHovered.value))
// Badges count notes as far past the pane as their slots reach.
const offscreenRange = computed(() => beatRange(OFFSCREEN_REACH + 4))
const offscreenNotes = computedArray(() => {
    const { min, max } = offscreenRange.value
    return culledEntities.value.filter(
        (entity) => entity.type === 'note' && isEntityInBeatRange(entity, min, max),
    )
})
// Note spans in lanes and seconds, which scrolling leaves unchanged.
const offscreenCandidates = computed(() => {
    const bpms = sceneState.value.bpms
    const layout = composed.value
    const { entities, selected } = showEntities(offscreenNotes.value, () => offscreenRange.value)
    return orderEntities(entities, selected, visibility()).flatMap(
        ({ entity, highlighted, opacity }) => {
            if (entity.type !== 'note') return []
            const position = layout?.notePosition(entity) ?? entity
            return [
                {
                    entity,
                    left: position.left,
                    right: position.left + position.size,
                    time: beatToTime(bpms, entity.beat),
                    highlighted,
                    opacity,
                },
            ]
        },
    )
})
// Only horizontal scrolling and zoom change which notes are off a side.
const offscreenAxis = computed<{ l: number; scale: number; width: number }>((previous) => {
    const { l, w } = viewBox.value
    const scale = view.w / w
    return previous?.l === l && previous.scale === scale && previous.width === view.w
        ? previous
        : { l, scale, width: view.w }
})
const offscreenSideNotes = computed(() => {
    const { l, scale, width } = offscreenAxis.value
    return offscreenCandidates.value.flatMap((note) => {
        const left = (note.left - l) * scale
        const right = (note.right - l) * scale
        return right < 0 || left > width ? [{ ...note, left, right }] : []
    })
})
// The pane y badges were last placed from, unrounded.
let lastOffscreenAnchor = 0
// The time badges scroll from; a zoom moves it onto the slot lattice near the middle.
const offscreenOrigin = computed<{ time: number; pixels: number }>((previous) => {
    // ups · scale without float error, so resizes and lane widths don't re-anchor.
    const pixels = -settings.pps
    if (previous?.pixels === pixels) return previous
    if (!previous) return { time: 0, pixels }
    const { t, w } = viewBox.value
    const shift = t * (view.w / w)
    const y = offscreenSlotNear(lastOffscreenAnchor, view.h / 2)
    // Kept when already there, so float error can't flip a note on it between slots.
    if (Math.abs(previous.time * pixels - shift - y) < 1e-6) return { time: previous.time, pixels }
    return { time: (y + shift) / pixels, pixels }
})
const offscreenAnchor = computed(() => {
    const { time, pixels } = offscreenOrigin.value
    const { t, w } = viewBox.value
    lastOffscreenAnchor = time * pixels - t * (view.w / w)
    // Whole device pixels keep the badges sharp.
    const ratio = pixelRatio.value
    return Math.round(lastOffscreenAnchor * ratio) / ratio
})
const offscreenGroups = computed<OffscreenNoteGroup<NoteEntity>[]>((previous) => {
    const { time: origin, pixels } = offscreenOrigin.value
    const anchor = offscreenAnchor.value
    const notes = offscreenSideNotes.value.map(({ entity, left, right, time, ...note }) => ({
        ...note,
        left,
        right,
        // From the origin, so notes keep their slots while scrolling.
        y: (time - origin) * pixels,
        // Dimmed notes are counted but not selectable.
        target: isVisible(entity) ? toCommittedEntity(entity) : undefined,
    }))
    // Clear of the range labels in the corners.
    const groups = groupOffscreenNotes(notes, view.w, 0, view.h, RANGE_LABEL_HEIGHT, anchor)
    // Unchanged badges keep their array, so they don't re-render.
    return previous && isSameOffscreenGroups(previous, groups) ? previous : groups
})
useOffscreenIndicators({
    navigation: () => undefined,
    bounds: () => view,
    groups: () => offscreenGroups.value,
    anchor: () => offscreenAnchor.value,
})
const hoveredOffscreenGroup = computed(() =>
    cursor.value === 'pointer' && tool.value === tools.select
        ? hitOffscreenIndicator(view.pointer.x, view.pointer.y)
        : undefined,
)
const contextInputs = computed(() => ({
    width: view.w,
    height: view.h,
    scale: view.w / viewBox.value.w,
    pixelRatio: pixelRatio.value,
    bounds: viewBox.value,
    ups: viewBox.value.ups,
    state: sceneState.value,
    composed: composed.value,
    defaultGroupId: defaultGroupId.value,
    showStageName: settings.showStageName,
    showGroupName: settings.showGroupName,
    nameContrast: settings.nameContrast,
    // Name contrast is measured against it.
    chartBackground: chartBackground.value,
    recentlyActive: isViewRecentlyActive.value,
    fontFamily: fontFamily.value,
    fontMiddle: fontMiddle.value,
    figureMiddle: figureMiddle.value,
    redrawVersion: redrawVersion.value,
}))

// Computed once per view, for the covered labels and the grid.
const labels = computed(() =>
    gridLabels(
        sceneState.value,
        viewBox.value.ups,
        view.w / viewBox.value.w,
        beats.value,
        times.value,
        settings.beatDisplay,
        drawnGrid.value,
    ),
)

const sameYs = (a: number[], b: number[]) =>
    a.length === b.length && a.every((y, index) => y === b[index])

// Grid labels under the time and beat labels over the chart are left out. Equal
// results keep the same object, so they redraw the chart only when they change.
const measureContext = document.createElement('canvas').getContext('2d')
const coveredYs = computed<EdgeLabelYs>((previous) => {
    if (!measureContext) return { left: [], right: [] }
    const ys = coveredLabelYs(
        { ...contextInputs.value, ctx: measureContext },
        beats.value,
        times.value,
        settings.beatDisplay,
        edgeLabelBoxes.value,
        labels.value,
    )
    return previous && sameYs(previous.left, ys.left) && sameYs(previous.right, ys.right)
        ? previous
        : ys
})

/** The ghosts the overlay draws, and the state they're drawn through. */
const shownGhosts = () => {
    // A drag's preview scene shows its drop itself; a pending draft's still shows a tool's
    // ghosts, but a Composed paste's, placed on the committed lattice, waits for the commit.
    const isComposedPaste = !!composed.value && tool.value === tools.paste
    // A Composed paste ghost placed on an earlier chart, such as before a draft committed, waits for its rebuild.
    const isStalePaste =
        isComposedPaste && ![undefined, state.value].includes(pasteGhostBase() as never)
    const showsGhosts =
        !isStalePaste &&
        (!isScenePreview.value || (!!previewEdit.value?.isDraft && !isComposedPaste))
    const preview = previewSlides.value
    // Previewed slides are drawn solid as they drop, without ghosts.
    const entities = !showsGhosts
        ? []
        : preview
          ? view.entities.creating.filter((entity) => !preview.includes(entity))
          : view.entities.creating
    return { entities, state: isComposedPaste ? pasteGhostState() : undefined }
}

// Beat labels make room for a drag's BPM ghost labels too.
const ghostBpmYs = computed<number[]>((previous) => {
    const ys: number[] = []
    if (isDragging.value) {
        const ghosts = shownGhosts()
        const bpms = (ghosts.state ?? sceneState.value).bpms
        for (const entity of ghosts.entities)
            if (entity.type === 'bpm') ys.push(beatToTime(bpms, entity.beat) * viewBox.value.ups)
    }
    return previous && sameYs(previous, ys) ? previous : ys
})

// The labels past lanes -6.1 and 6.1 that Basic time lines stop short of, in pane pixels.
// Not while playing or scrubbing, as the labels passing the cursor would make its ends jump.
const columnBoxes = computed<SideBoxes | undefined>(() => {
    if (composed.value || isPlaying.value || isPreviewScrubbing.value) return
    const bounds = viewBox.value
    const scale = view.w / bounds.w
    const covered = coveredYs.value
    // BPM labels, drag ghosts' too, take the beat labels' place.
    const bpmYs = [
        ...(view.visibilities.bpm || settings.showOtherObjects
            ? bpmLabelYs(sceneState.value, beats.value, bounds.ups)
            : []),
        ...ghostBpmYs.value,
    ]
    const beatYs = [...bpmYs, ...covered.right]
    // Half a label's size above and below: 0.4 for the grid's, 0.5 for BPMs'.
    const box = (y: number, half: number, left: number, right: number) => ({
        left: (left - bounds.l) * scale,
        right: (right - bounds.l) * scale,
        top: (y - half - bounds.t) * scale,
        bottom: (y + half - bounds.t) * scale,
    })
    const { left, right } = labels.value
    return {
        left: left
            .filter(({ y }) => !isNearLabel(covered.left, y))
            .map(({ y }) => box(y, 0.2, -Infinity, -6.1)),
        right: [
            ...right
                .filter(({ y }) => !isNearLabel(beatYs, y))
                .map(({ y }) => box(y, 0.2, 6.1, Infinity)),
            ...bpmYs.map((y) => box(y, BPM_LABEL.size / 2, BPM_LABEL.lane, Infinity)),
        ],
    }
})

const drawEntity = (
    context: EditorDrawContext,
    entity: Entity,
    highlighted: boolean,
    opacity = 1,
    part?: DrawStep['part'],
) => {
    if (entity.type === 'note') notes.draw(context, entity, highlighted, opacity)
    else if (entity.type === 'connector') connectors.draw(context, entity, highlighted, opacity)
    else drawEvent(context, entity, highlighted, opacity, part)
}

// A time line's ends in lanes: `lanes` either side, or the whole Composed workspace, cut to `span`.
const timeLineEnds = (
    { bounds, scale, composed }: typeof contextInputs.value,
    lanes: number,
    span: LineSpan,
): LineSpan | undefined => {
    const left = Math.max(composed ? bounds.l : -lanes, bounds.l + span.left / scale)
    const right = Math.min(composed ? bounds.r : lanes, bounds.l + span.right / scale)
    return left < right ? { left, right } : undefined
}

const traceTimeLine = (ctx: CanvasRenderingContext2D, ends: LineSpan | undefined, y: number) => {
    if (!ends) return
    ctx.moveTo(ends.left, y)
    ctx.lineTo(ends.right, y)
}

// The hover line's dash and gap, in pixels.
const DASH = 6
const GAP = 4

// Hover line dashes; kept within 0.75 of the length's count so small changes don't regroup them.
let hoverDashes = 0

// Stretches the dash pattern slightly so the line starts and ends on a whole dash.
const strokeDashedTimeLine = (
    ctx: CanvasRenderingContext2D,
    ends: LineSpan | undefined,
    y: number,
    scale: number,
) => {
    if (!ends) return
    const length = (ends.right - ends.left) * scale
    const count = (length + GAP) / (DASH + GAP)
    if (!hoverDashes || Math.abs(hoverDashes - count) >= 0.75)
        hoverDashes = Math.max(1, Math.round(count))
    // Fits the dashes and the gaps between them exactly.
    const stretch = length / (hoverDashes * (DASH + GAP) - GAP)
    ctx.setLineDash([(DASH * stretch) / scale, (GAP * stretch) / scale])
    ctx.beginPath()
    ctx.moveTo(ends.left, y)
    ctx.lineTo(ends.right, y)
    ctx.stroke()
}

// Equal ends keep their object, so hovering redraws the chart only when the cursor line changes.
const cursorLineEnds = computed<LineSpan | undefined>((previous) => {
    const inputs = contextInputs.value
    const y = (view.cursorTime * inputs.ups - inputs.bounds.t) * inputs.scale
    const ends = timeLineEnds(inputs, 7, lineSpanAt(y, columnBoxes.value))
    return previous?.left === ends?.left && previous?.right === ends?.right ? previous : ends
})

// Dependencies are captured synchronously; rendering runs once with the latest
// snapshot. Pointer-only overlays do not invalidate the chart underneath them.
watchEffect(
    () => {
        if (!isAppActive.value) {
            chartFrame.cancel()
            return
        }
        const canvas = chartCanvas.value
        const inputs = contextInputs.value
        if (!canvas || !inputs.width || !inputs.height) return
        const entities = drawSteps.value
        const hovered = inputs.recentlyActive ? undefined : hoveredSet.value
        const preview = previewSlides.value
        const visibilities = view.visibilities
        // Captured here: the frame callback runs untracked.
        const scope = scopeLookup.value
        const showOtherObjects = settings.showOtherObjects
        // BPM labels are drawn, faintly, with other objects too.
        const isBpmVisible = visibilities.bpm || showOtherObjects
        const currentBeats = beats.value
        const currentTimes = times.value
        const division = view.division
        const laneDivision = view.laneDivision
        const beatDisplay = settings.beatDisplay
        const grid = drawnGrid.value
        const cursor = view.cursorTime
        const cursorEnds = cursorLineEnds.value
        const covered = coveredYs.value
        const ghostYs = ghostBpmYs.value
        const currentLabels = labels.value
        const currentWaveform = settings.waveform === 'off' ? undefined : inputs.state.bgm.waveform
        const offset = inputs.state.bgm.offset + bgmOffsetDelta.value
        void waveformVersion.value
        void stageSettle.value
        chartFrame.schedule((timestamp) => {
            notes.beginFrame(timestamp)
            nameSprites.beginFrame(timestamp)
            const ctx = prepareSurface(
                canvas,
                inputs.width,
                inputs.height,
                inputs.pixelRatio,
                inputs.bounds,
            )
            if (!ctx) return
            const base = { ...inputs, ctx, nameSprites }
            // Measured with the frame's font and bounds, as the labels are drawn.
            const timeScaleYs = timeScaleEdgeLabelYs(base, entities)
            const edgeLabelYs = {
                left: [...timeScaleYs.left, ...covered.left],
                right: [...timeScaleYs.right, ...covered.right, ...ghostYs],
            }
            const context = { ...base, names: createNameLayer() }
            const previewContext = preview && { ...context, state: preview.state }
            waveform.draw(context, currentWaveform, offset, currentTimes)
            if (
                stages.draw(context, inputs.width, inputs.height, currentBeats, scope, laneDivision)
            ) {
                // Not the next frame: stepped input and slow frames would alternate exact redraws.
                clearTimeout(stageSettleTimer)
                stageSettleTimer = setTimeout(() => stageSettle.value++, SUSTAINED_MS)
            }
            drawGrid(
                context,
                currentBeats,
                currentTimes,
                division,
                laneDivision,
                beatDisplay,
                isBpmVisible,
                edgeLabelYs,
                currentLabels,
                grid,
            )
            ctx.save()
            ctx.strokeStyle = '#fff'
            ctx.beginPath()
            traceTimeLine(ctx, cursorEnds, cursor * inputs.ups)
            ctx.stroke()
            ctx.restore()
            drawEventInfinities(context, visibilities, scope, showOtherObjects)
            for (const { entity, highlighted, opacity, part } of entities) {
                drawEntity(
                    previewContext && preview.entities.has(entity) ? previewContext : context,
                    entity,
                    highlighted || !!hovered?.has(entity),
                    opacity,
                    part,
                )
            }
            placeNames(context, context.names)
        })
    },
    { flush: 'post' },
)

watchEffect(
    () => {
        if (!isAppActive.value) {
            overlayFrame.cancel()
            return
        }
        const canvas = overlayCanvas.value
        const inputs = contextInputs.value
        if (!canvas || !inputs.width || !inputs.height) return
        const { entities: creating, state: ghostState } = shownGhosts()
        const range = artRange.value
        const hovered = sceneHovered.value
        const preview = previewSlides.value
        // Previewed slides are outlined where they're drawn.
        const selected = preview
            ? [
                  ...visibleSelectedEntities.value.filter((entity) => !preview.includes(entity)),
                  ...preview.state.selectedEntities.filter(
                      (entity) =>
                          preview.includes(entity) &&
                          entityScopeVisibility(entity, scopeLookup.value) !== 'hidden',
                  ),
              ]
            : visibleSelectedEntities.value
        const selection = view.selection
        const hoverEnds = view.isHoverHidden
            ? undefined
            : timeLineEnds(inputs, 6, lineSpanAt(hoverLabelCenter.value, columnBoxes.value))
        const hover = view.isHoverHidden ? undefined : view.hoverTime
        overlayFrame.schedule((timestamp) => {
            notes.beginFrame(timestamp)
            nameSprites.beginFrame(timestamp)
            const ctx = prepareSurface(
                canvas,
                inputs.width,
                inputs.height,
                inputs.pixelRatio,
                inputs.bounds,
            )
            if (!ctx) return
            if (creating.length) {
                // Composite the entire preview once, retaining SVG group opacity at
                // overlapping notes and connectors. Allocate only during gestures.
                creatingCanvas ??= document.createElement('canvas')
                const creatingContext = prepareSurface(
                    creatingCanvas,
                    inputs.width,
                    inputs.height,
                    inputs.pixelRatio,
                    inputs.bounds,
                )
                if (creatingContext) {
                    const context = {
                        ...inputs,
                        state: ghostState ?? inputs.state,
                        composed: ghostState ? createComposedLayout(ghostState) : inputs.composed,
                        ctx: creatingContext,
                        nameSprites,
                        slideInfos: tool.value === tools.paste ? pasteGhostInfos() : undefined,
                    }
                    for (const entity of creating) {
                        if (isEntityInBeatRange(entity, range.min, range.max))
                            drawEntity(context, entity, true)
                    }
                    ctx.save()
                    ctx.setTransform(1, 0, 0, 1, 0, 0)
                    ctx.globalAlpha = 0.5
                    ctx.drawImage(creatingCanvas, 0, 0)
                    ctx.restore()
                }
            } else if (creatingCanvas) {
                creatingCanvas.width = creatingCanvas.height = 1
                creatingCanvas = undefined
            }

            ctx.save()
            ctx.strokeStyle = '#fff'
            ctx.fillStyle = '#fff'
            ctx.setLineDash([DASH / inputs.scale, GAP / inputs.scale])
            ctx.globalAlpha = 0.5
            for (const entities of [hovered, selected]) {
                for (const entity of entities) {
                    const hitbox = inputs.composed?.hitbox(entity) ?? entity.hitbox
                    if (!hitbox) continue
                    ctx.strokeRect(
                        hitbox.lane - hitbox.w - 0.1,
                        beatToTime(inputs.state.bpms, hitbox.beat) * inputs.ups - hitbox.h - 0.1,
                        hitbox.w * 2 + 0.2,
                        hitbox.h * 2 + 0.2,
                    )
                }
            }
            if (selection) {
                const x = selection.laneMin
                const y = selection.timeMax * inputs.ups
                const w = selection.laneMax - selection.laneMin
                const h = (selection.timeMin - selection.timeMax) * inputs.ups
                ctx.globalAlpha = 0.25
                ctx.fillRect(x, y, w, h)
                ctx.globalAlpha = 0.5
                ctx.strokeRect(x, y, w, h)
            }
            if (hover !== undefined)
                strokeDashedTimeLine(ctx, hoverEnds, hover * inputs.ups, inputs.scale)
            ctx.restore()
        })
    },
    { flush: 'post' },
)

let pixelRatioQuery: MediaQueryList | undefined
const updatePixelRatio = () => {
    pixelRatio.value = devicePixelRatio || 1
    pixelRatioQuery?.removeEventListener('change', updatePixelRatio)
    pixelRatioQuery = matchMedia(`(resolution: ${pixelRatio.value}dppx)`)
    pixelRatioQuery.addEventListener('change', updatePixelRatio)
}
const updateFont = () => {
    if (container.value) {
        fontFamily.value = getComputedStyle(container.value).fontFamily
        fontMiddle.value = measureTextMiddle(fontFamily.value, container.value)
        figureMiddle.value = measureFigureMiddle(fontFamily.value)
    }
    clearTextWidths()
    nameSprites.clear()
    redrawVersion.value++
}
const restoreContext = () => {
    notes.clear()
    nameSprites.clear()
    connectors.clear()
    stages.clear()
    // A restored surface has lost its pixels even if chart time is paused.
    redrawVersion.value++
}

onMounted(() => {
    updatePixelRatio()
    updateFont()
    window.addEventListener('resize', updatePixelRatio)
    document.fonts.addEventListener('loadingdone', updateFont)
})
onUnmounted(() => {
    clearTimeout(stageSettleTimer)
    chartFrame.cancel()
    overlayFrame.cancel()
    notes.clear()
    nameSprites.clear()
    connectors.clear()
    stages.clear()
    waveform.clear()
    if (creatingCanvas) creatingCanvas.width = creatingCanvas.height = 1
    window.removeEventListener('resize', updatePixelRatio)
    pixelRatioQuery?.removeEventListener('change', updatePixelRatio)
    document.fonts.removeEventListener('loadingdone', updateFont)
})
</script>

<template>
    <div
        ref="container"
        class="editor absolute size-full touch-none"
        :style="{ cursor }"
        @pointerenter="activateEditorNavigation()"
        @focusin="activateEditorNavigation()"
        v-on="controlListeners"
    >
        <canvas
            ref="chart"
            class="editor-chart pointer-events-none absolute size-full"
            @contextrestored="restoreContext"
        />
        <canvas
            ref="overlay"
            class="editor-overlay pointer-events-none absolute size-full"
            @contextrestored="restoreContext"
        />
        <OffscreenNoteIndicators
            :groups="offscreenGroups"
            :hovered="hoveredOffscreenGroup"
            :anchor="offscreenAnchor"
        />
    </div>
</template>
