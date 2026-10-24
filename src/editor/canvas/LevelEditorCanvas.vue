<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, useTemplateRef, watch, watchEffect } from 'vue'
import { beats, keys, times } from '..'
import { isAppActive } from '../../activity'
import { state } from '../../history'
import { defaultGroupId } from '../../history/groups'
import { cullAllEntities } from '../../history/store'
import { isPlaying } from '../../player'
import { previewEdit } from '../../preview/edit'
import { settings } from '../../settings'
import {
    disposeDrawContext,
    type RenderSurface,
    type WebGLDrawContext,
} from '../../rendering/context'
import { createFontContext } from '../../rendering/textRaster'
import RenderingError from '../../rendering/RenderingError.vue'
import { useEditorRenderer } from '../../rendering/useEditorRenderer'
import { hasSameChartData } from '../../state/data'
import type { Entity } from '../../state/entities'
import type { ConnectorEntity } from '../../state/entities/slides/connector'
import { BPM_LABEL } from '../../state/entities/bpm'
import type { NoteEntity } from '../../state/entities/slides/note'
import { beatToTime, isSameTempo, timeToBeat } from '../../state/integrals/bpms'
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
import { scopeLookup, showGroupNames, showStageNames } from '../scope'
import { bgmOffsetDelta } from '../tools/offset'
import { tool, tools } from '../tools'
import { pasteGhostBase, pasteGhostInfos, pasteGhostState } from '../tools/paste'
import { slideAddGhost } from '../tools/slide/addPreview'
import { isVisible } from '../tools/utils'
import { hoveredEntities, isViewRecentlyActive, view, viewBox } from '../view'
import LevelEditorHoverMarkers from '../LevelEditorHoverMarkers.vue'
import LevelEditorRangeMarkers from '../LevelEditorRangeMarkers.vue'
import OffscreenNoteIndicators from '../OffscreenNoteIndicators.vue'
import QuickScrollZone from '../QuickScrollZone.vue'
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
import { shownMarkerTime } from '../hoverMarker'
import { changeMarks, undimmed } from '../history/changes'
import { hereRange, historyFilter } from '../history/state'
import { drawChangeMarks, drawHereBracket } from './changes'
import { createConnectorRenderer } from './connectors'
import { drawEvent, drawEventInfinities } from './events'
import { EventAnnotations } from './eventAnnotations'
import {
    bpmLabelYs,
    coveredLabelYs,
    drawGridLabels,
    drawGridLines,
    gridLabels,
    isNearLabel,
    timeScaleEdgeLabelYs,
} from './grid'
import { createLabelSprites } from './labelSprites'
import { createNameLayer, placeNames } from './names'
import { createNoteRenderer } from './notes'
import { raisedToolChain } from '../raisedTool'
import { orderEntities, raisedChains, toDrawSteps, type DrawStep } from './ordering'
import { createFrameScheduler, prepareSurface } from './surface'
import { timed } from '../../perf/probe'
import { clearTextWidths, FIGURE_MIDDLE, measureFigureMiddle, measureTextMiddle } from './text'
import type { EdgeLabelYs, EditorDrawContext } from './types'
import { createWaveformRenderer } from './waveform'
import { createComposedLayout } from '../composed'
import { createStageSurface, SUSTAINED_MS } from './stageSurface'
import { VectorRanges } from './vectorRanges'
import { SectionPlanner, selectSections, type SectionPlan } from './sections'

const container = useTemplateRef('container')
const { cursor, cursorListeners } = useCanvasCursor(() => undefined)
const controlListeners = { ...controlsForNavigation(() => undefined), ...cursorListeners }
const chartCanvas = useTemplateRef<HTMLCanvasElement>('chart')
const overlayCanvas = useTemplateRef<HTMLCanvasElement>('overlay')
const editorRenderer = useEditorRenderer()
const graphicsError = editorRenderer.error
const rendererVersion = ref(0)
const pixelRatio = ref(devicePixelRatio || 1)
const fontFamily = ref('sans-serif')
const fontMiddle = ref(0.25)
const figureMiddle = ref(FIGURE_MIDDLE)
const redrawVersion = ref(0)
const waveformVersion = ref(0)
// Bumped once shifted stage pixels have held still for a motion's gap, to redraw them exactly.
const stageSettle = ref(0)
// Each chart draw with shifted stage pixels moves the deadline; one timer follows it, so a
// sustained motion arms a timer about once per gap instead of once per frame.
let stageSettleDue: number | undefined
let stageSettleTimer: ReturnType<typeof setTimeout> | undefined
const armStageSettle = () => {
    if (stageSettleTimer !== undefined || stageSettleDue === undefined) return
    stageSettleTimer = setTimeout(
        () => {
            stageSettleTimer = undefined
            if (stageSettleDue === undefined) return
            if (performance.now() < stageSettleDue) {
                armStageSettle()
                return
            }
            stageSettleDue = undefined
            stageSettle.value++
        },
        Math.max(0, stageSettleDue - performance.now()),
    )
}
const chartFrame = createFrameScheduler()
const overlayFrame = createFrameScheduler()
const notes = createNoteRenderer()
const nameSprites = createLabelSprites()
const connectors = createConnectorRenderer()
const stages = createStageSurface()
const vectors = new VectorRanges()
const annotations = new EventAnnotations()
const sectionPlanner = new SectionPlanner()
const composed = computed(() =>
    view.layout === 'composed' && sceneState.value.isDynamicStages
        ? createComposedLayout(sceneState.value)
        : undefined,
)
const waveform = createWaveformRenderer(() => waveformVersion.value++)
let creatingCanvas: RenderSurface | undefined

// Capture the old element before Vue clears template refs during teardown.
for (const element of [chartCanvas, overlayCanvas]) {
    watch(element, (canvas, previous, onCleanup) => {
        if (canvas)
            onCleanup(() => {
                editorRenderer.forget(canvas)
                disposeDrawContext(canvas)
            })
    })
}

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
// The selection, with a dropping drag's own selected entities.
const shownSelected = computed(() => {
    const preview = previewSlides.value
    if (!preview) return selectedEntitySet.value
    return new Set([
        ...selectedEntitySet.value,
        ...preview.state.selectedEntities.filter(preview.includes),
    ])
})
// Slides a drag changes beyond its ghosts are drawn as they drop; only then is the range read.
const showEntities = (shown: Entity[], range: () => { min: number; max: number }) => {
    const preview = previewSlides.value
    if (!preview) return { entities: shown, selected: shownSelected.value }
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
    return { entities, selected: shownSelected.value }
}
const shownEntities = computed(() => showEntities(artEntities.value, () => artRange.value))
const visibility = () => ({
    scope: scopeLookup.value,
    visibilities: view.visibilities,
    showOtherObjects: settings.showOtherObjects,
    // While a peeked entry's change is shown, what it didn't change dims.
    ...(undimmed.value ? { undimmed: undimmed.value } : {}),
})
// Built per selection; ordering and the extension passes share it.
const chains = computed(() => raisedChains(shownSelected.value, raisedToolChain.value))
const orderedEntities = computed(() =>
    orderEntities(
        shownEntities.value.entities,
        shownEntities.value.selected,
        visibility(),
        chains.value,
    ),
)
// Previewed entities retain the existing store-order substitution path. Outside
// previews, source ordering and complete sections do not depend on the camera.
const sectionPlan = computed<SectionPlan | undefined>((previous) => {
    if (previewSlides.value || isScenePreview.value) return previous
    return sectionPlanner.build(
        sceneState.value.store,
        shownSelected.value,
        visibility(),
        chains.value,
    )
})
const sectionFrame = computed(() => {
    if (previewSlides.value || isScenePreview.value) return
    const plan = sectionPlan.value
    if (!plan) return
    const { min, max } = artRange.value
    return selectSections(plan, min, max, keys.value.min, keys.value.max)
})
const drawSteps = computed(() => sectionFrame.value ?? toDrawSteps(orderedEntities.value))
// Hovered objects are committed ones; a previewed scene draws their counterparts.
const sceneHovered = computed(() =>
    sceneCounterparts.value
        ? hoveredEntities.value.map((entity) => toSceneEntity(entity))
        : hoveredEntities.value,
)
const hoveredSet = computed(() => new Set(sceneHovered.value))
// Badges count notes as far past the pane as their slots reach.
const offscreenRange = computed(() => beatRange(OFFSCREEN_REACH + 4))
// The culled entities already reach that far (see `keys`), and the grouping leaves out any note
// past its slots, so the candidates need no range of their own outside a previewed drop.
const offscreenNotes = computedArray(() =>
    culledEntities.value.filter((entity) => entity.type === 'note'),
)
// Only horizontal scrolling and zoom change which notes are off a side.
const offscreenAxis = computed<{ l: number; scale: number; width: number }>((previous) => {
    const { l, w } = viewBox.value
    const scale = view.w / w
    return previous?.l === l && previous.scale === scale && previous.width === view.w
        ? previous
        : { l, scale, width: view.w }
})
// The notes off a side, with their spans in pane x and their times. Notes in the lanes are left
// out before ordering, which is per entity: the few that remain keep their painter order.
const offscreenSideNotes = computed(() => {
    const { l, scale, width } = offscreenAxis.value
    const bpms = sceneState.value.bpms
    const layout = composed.value
    const { entities, selected } = showEntities(offscreenNotes.value, () => offscreenRange.value)
    const spans = new Map<Entity, { left: number; right: number }>()
    const sideNotes: Entity[] = []
    for (const entity of entities) {
        if (entity.type !== 'note') continue
        const position = layout?.notePosition(entity) ?? entity
        const left = (position.left - l) * scale
        const right = (position.left + position.size - l) * scale
        if (right >= 0 && left <= width) continue
        spans.set(entity, { left, right })
        sideNotes.push(entity)
    }
    return orderEntities(sideNotes, selected, visibility(), chains.value).flatMap(
        ({ entity, highlighted, opacity }) => {
            const span = spans.get(entity)
            if (entity.type !== 'note' || !span) return []
            return [{ entity, ...span, time: beatToTime(bpms, entity.beat), highlighted, opacity }]
        },
    )
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
    showStageName: showStageNames.value,
    showGroupName: showGroupNames.value,
    nameContrast: settings.nameContrast,
    // Name contrast is measured against it.
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
const measureContext = createFontContext()
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

// A Basic drag's ghost ribbons, as a paste's: its preview's connectors at the notes it moves.
const dragGhostConnectors = computed<ConnectorEntity[]>(() => {
    const edit = previewEdit.value
    const ghosts = view.entities.creating
    if (!edit?.isDrag || isScenePreview.value || !ghosts.length) return []
    const source = state.value
    if (!hasSameChartData(source, edit.source)) return []
    const committed = source.store.slides.note
    // Only slides with connectors; the rest skip building the preview.
    const slideIds = new Set(
        ghosts.flatMap((ghost) =>
            ghost.type === 'note' && (committed.get(ghost.slideId)?.length ?? 0) > 1
                ? [ghost.slideId]
                : [],
        ),
    )
    if (!slideIds.size) return []
    const preview = edit.resolve()
    if (!isSameTempo(preview.bpms, source.bpms)) return []
    // Previewed slides are drawn solid as they drop.
    const solid = previewSlides.value
    return [...slideIds].flatMap((id) => {
        // Pieces the committed slide lacks, such as one a reorder makes between kept notes.
        const tails = new Map(
            (source.store.slides.connector.get(id) ?? []).map(({ head, tail }) => [head, tail]),
        )
        return (preview.store.slides.connector.get(id) ?? []).filter(
            (connector) =>
                !solid?.includes(connector) && tails.get(connector.head) !== connector.tail,
        )
    })
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
    // A Slide add's ghost, from either pane, shows the pieces and ticks it changes.
    const added = slideAddGhost(view.entities.creating)
    // Previewed slides are drawn solid as they drop, without ghosts.
    const entities = !showsGhosts
        ? []
        : [
              // Under the notes, as a paste's.
              ...dragGhostConnectors.value,
              ...(added ? [...added.connectors, ...added.ticks] : []),
              ...(preview
                  ? view.entities.creating.filter((entity) => !preview.includes(entity))
                  : view.entities.creating),
          ]
    return {
        entities,
        state: isComposedPaste ? pasteGhostState() : undefined,
        // Notes are drawn as their slides land.
        infos: tool.value === tools.paste ? pasteGhostInfos() : added?.infos,
    }
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
    drawNames = true,
) => {
    if (entity.type === 'note')
        notes.draw(context, entity, highlighted, opacity, undefined, drawNames)
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

const traceTimeLine = (ctx: WebGLDrawContext, ends: LineSpan | undefined, y: number) => {
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
    ctx: WebGLDrawContext,
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
    ctx.save()
    ctx.setLineDash([(DASH * stretch) / scale, (GAP * stretch) / scale])
    // Keep the dashed geometry independent of scrolling and hover position.
    ctx.translate(ends.left, y)
    ctx.strokeLine(0, 0, ends.right - ends.left, 0)
    ctx.restore()
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
        const { objects, raisedAt, labels: entityLabels } = drawSteps.value
        const sections = sectionFrame.value
        const allSections = sections && sectionPlan.value?.sections
        const raised = chains.value
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
        const draw = (timestamp: number) => {
            notes.beginFrame(timestamp)
            nameSprites.beginFrame(timestamp)
            const ctx = prepareSurface(
                canvas,
                inputs.width,
                inputs.height,
                inputs.pixelRatio,
                inputs.bounds,
                () => editorRenderer.getContext(canvas),
            )
            if (!ctx) return
            const base = { ...inputs, ctx, nameSprites }
            // Measured with the frame's font and bounds, as the labels are drawn.
            const timeScaleYs = timeScaleEdgeLabelYs(base, entityLabels)
            const edgeLabelYs = {
                left: [...timeScaleYs.left, ...covered.left],
                right: [...timeScaleYs.right, ...covered.right, ...ghostYs],
            }
            const context = { ...base, names: createNameLayer() }
            const previewContext = preview && { ...context, state: preview.state }
            // Slide previews substitute notes/connectors; event labels stay committed.
            annotations.beginFrame(context, entityLabels)
            vectors.beginFrame(context, [inputs.redrawVersion])
            if (allSections) vectors.prepareSections(allSections, sections.sections)
            else vectors.prepare(objects, raisedAt, preview?.entities)
            // Populate mutable atlas pages before this frame queues any readers.
            // A cold jump then presents the chart once, rather than flushing it
            // whenever another previously unseen note needs an atlas slot.
            const readySections = allSections
                ? notes.prepareSections(context, allSections, sections.sections, hovered)
                : undefined
            const prepareNote = ({ entity, highlighted, opacity }: DrawStep) => {
                if (entity.type !== 'note') return
                notes.prepare(
                    previewContext && preview.entities.has(entity) ? previewContext : context,
                    entity,
                    highlighted || !!hovered?.has(entity),
                    opacity,
                )
            }
            if (sections && readySections) {
                for (const section of sections.sections) {
                    if (readySections.has(section)) continue
                    for (const step of sections.visibleBySection.get(section) ?? [])
                        prepareNote(step)
                }
            } else {
                for (const step of objects) prepareNote(step)
                notes.prepareRuns(context, objects, raisedAt, preview?.entities)
            }
            waveform.draw(context, currentWaveform, offset, currentTimes)
            const shiftedStages = stages.draw(
                context,
                inputs.width,
                inputs.height,
                currentBeats,
                scope,
                laneDivision,
            )
            stageSettleDue = undefined
            drawGridLines(context, currentBeats, division, laneDivision, beatDisplay, grid)
            ctx.save()
            ctx.strokeStyle = '#fff'
            ctx.beginPath()
            traceTimeLine(ctx, cursorEnds, cursor * inputs.ups)
            ctx.stroke()
            ctx.restore()
            drawEventInfinities(context, visibilities, scope, showOtherObjects, raised)
            const drawStep = (target: EditorDrawContext, step: DrawStep, drawNames = true) => {
                const { entity, highlighted, opacity, part } = step
                drawEntity(
                    previewContext && preview.entities.has(entity) ? previewContext : target,
                    entity,
                    highlighted || !!hovered?.has(entity),
                    opacity,
                    part,
                    drawNames,
                )
            }
            const drawNotes = (from: number, to: number, pass: string) => {
                notes.drawRun(context, objects, from, to, pass, hovered, drawStep)
            }
            const drawSections = (pass: 'normal' | 'raised') => {
                if (!sections) return
                for (const section of sections.sections) {
                    if (section.pass !== pass) continue
                    const visible = sections.visibleBySection.get(section) ?? []
                    if (section.steps[0]?.entity.type === 'note') {
                        if (!notes.drawSection(context, section))
                            // Keep the preparation context so both bodies and names reuse it.
                            for (const step of visible) drawStep(context, step, false)
                        // Keep name requests at the original painter-order point.
                        notes.drawVisibleNames(context, visible, hovered)
                    } else if (section.live) {
                        for (const step of visible) drawStep(context, step)
                    } else vectors.drawSection(context, section, hovered, drawStep, sections.owners)
                }
            }
            if (sections) drawSections('normal')
            else vectors.draw(context, objects, 0, raisedAt, 'normal', hovered, drawStep, drawNotes)
            // Raised chains' extensions rise with their lines.
            if (raised.size)
                drawEventInfinities(context, visibilities, scope, showOtherObjects, raised, true)
            if (sections) drawSections('raised')
            else
                vectors.draw(
                    context,
                    objects,
                    raisedAt,
                    objects.length,
                    'raised',
                    hovered,
                    drawStep,
                    drawNotes,
                )
            // Text goes above every object.
            drawGridLabels(
                context,
                currentBeats,
                currentTimes,
                beatDisplay,
                isBpmVisible,
                edgeLabelYs,
                currentLabels,
            )
            for (const step of entityLabels) {
                const highlighted = step.highlighted || !!hovered?.has(step.entity)
                if (!annotations.draw(context, step.entity, highlighted, step.opacity))
                    drawStep(context, step)
            }
            placeNames(context, context.names)
            ctx.flush()
            notes.endFrame()
            vectors.endFrame()
            annotations.endFrame()
            stages.finishFrame()
            if (shiftedStages) {
                // Idle time begins after the whole chart is submitted. Slow object
                // drawing must not consume the pause before an exact settled redraw.
                stageSettleDue = performance.now() + SUSTAINED_MS
                armStageSettle()
            }
        }
        chartFrame.schedule(timed('chartDraw', draw))
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
        const { entities: creating, state: ghostState, infos: ghostInfos } = shownGhosts()
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
        // A peeked entry's change, and Edits Here's range.
        const marks = changeMarks.value
        const bracket = historyFilter.value === 'here' ? hereRange.value : undefined
        const markScope = scopeLookup.value
        const markVisibilities = view.visibilities
        const markOthers = settings.showOtherObjects
        const hover = shownMarkerTime.value
        const hoverEnds =
            hover === undefined
                ? undefined
                : timeLineEnds(inputs, 6, lineSpanAt(hoverLabelCenter.value, columnBoxes.value))
        const draw = (timestamp: number) => {
            notes.beginFrame(timestamp)
            nameSprites.beginFrame(timestamp)
            const ctx = prepareSurface(
                canvas,
                inputs.width,
                inputs.height,
                inputs.pixelRatio,
                inputs.bounds,
                () => editorRenderer.getContext(canvas),
            )
            if (!ctx) return
            if (creating.length) {
                // Composite the entire preview once, retaining SVG group opacity at
                // overlapping notes and connectors. Allocate only during gestures.
                if (creatingCanvas?.getContext().isContextLost()) {
                    creatingCanvas.dispose()
                    creatingCanvas = undefined
                }
                creatingCanvas ??= ctx.createSurface(canvas.width, canvas.height)
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
                        slideInfos: ghostInfos,
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
                creatingCanvas.dispose()
                creatingCanvas = undefined
            }

            if (marks || bracket) {
                const context = { ...inputs, ctx, nameSprites }
                if (bracket) drawHereBracket(context, bracket.from, bracket.to)
                // Changes in hidden groups or stages are counted, not drawn.
                if (marks)
                    drawChangeMarks(
                        context,
                        marks,
                        range.min,
                        range.max,
                        (entity) =>
                            entityScopeVisibility(entity, markScope) !== 'hidden' &&
                            (markVisibilities[entity.type] || markOthers),
                        (target, entity, opacity) => {
                            drawEntity(target, entity, false, opacity)
                        },
                    )
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
            ctx.flush()
        }
        overlayFrame.schedule(timed('overlayDraw', draw))
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
    // renderingready follows Pixi's native-map reset. The raw restore event can
    // reach Vue first, while retained geometry still holds old GL handles.
    vectors.clear()
    annotations.clear()
    notes.clear()
    nameSprites.clear()
    connectors.clear()
    stages.clear()
    // A restored surface has lost its pixels even if chart time is paused.
    redrawVersion.value++
}
const retryRenderer = () => {
    // Fresh elements get fresh GL contexts; losing a context does not make the
    // same canvas available for another allocation.
    creatingCanvas?.dispose()
    creatingCanvas = undefined
    waveform.clear()
    restoreContext()
    rendererVersion.value++
}

onMounted(() => {
    updatePixelRatio()
    updateFont()
    window.addEventListener('resize', updatePixelRatio)
    document.fonts.addEventListener('loadingdone', updateFont)
})
onUnmounted(() => {
    vectors.clear()
    annotations.clear()
    stageSettleDue = undefined
    clearTimeout(stageSettleTimer)
    stageSettleTimer = undefined
    chartFrame.cancel()
    overlayFrame.cancel()
    notes.clear()
    nameSprites.clear()
    connectors.clear()
    stages.clear()
    waveform.clear()
    creatingCanvas?.dispose()
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
            :key="`chart:${rendererVersion}`"
            class="editor-chart pointer-events-none absolute size-full"
            @renderingready="restoreContext"
        />
        <canvas
            ref="overlay"
            :key="`overlay:${rendererVersion}`"
            class="editor-overlay pointer-events-none absolute size-full"
            @renderingready="restoreContext"
        />
        <!-- Over the drawn chart, under the labels and badges. -->
        <QuickScrollZone :pane-width="view.w" />
        <!-- The time and beat labels sit above everything drawn, under the badges. -->
        <LevelEditorRangeMarkers />
        <LevelEditorHoverMarkers />
        <OffscreenNoteIndicators
            :groups="offscreenGroups"
            :hovered="hoveredOffscreenGroup"
            :anchor="offscreenAnchor"
        />
        <RenderingError v-if="graphicsError" :message="graphicsError" @reload="retryRenderer" />
    </div>
</template>
