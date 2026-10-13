import { computed } from 'vue'
import type { StageId } from '../../chart/stages'
import { state } from '../../history'
import { getPreviewState, previewEdit } from '../../preview/edit'
import { attachEasedFrac, createPreviewChartBuilder } from '../../preview/engine/chart'
import type { PreviewChart, PreviewNote } from '../../preview/engine/model'
import { getStageProps } from '../../preview/engine/stage'
import { settings } from '../../settings'
import type { State } from '../../state'
import { hasSameChartData } from '../../state/data'
import type { SlideId } from '../../state/entities/slides'
import { sameBeatAttachmentFraction } from '../../state/entities/slides/attachment'
import type { NoteEntity } from '../../state/entities/slides/note'
import { beatToTime, isSameTempo } from '../../state/integrals/bpms'
import { dominantDivision } from '../composed'
import { getComposedLayout } from '../composedView'
import { isScenePreview, previewSlides } from '../sceneState'
import { scopeLookup } from '../scope'
import { entityScopeVisibility } from '../scopeRules'
import { view } from '../view'
import { getNotesAtBeat } from './candidates'
import { layoutElevationNotes, type ElevationNote, type ElevationRow } from './layout'
import { elevationBeat } from './state'
import { elevationBounds, elevationViewport } from './viewport'

const buildChart = createPreviewChartBuilder()
export const elevationState = computed(() => getPreviewState(state.value, previewEdit.value))
type CompiledChart = {
    chart: PreviewChart
    bySource: Map<NoteEntity, { compiled: PreviewNote; order: number; ordinal: number }>
}
const indexChart = (chart: PreviewChart): CompiledChart => {
    const orders = new Map<NoteEntity['slideId'], number>()
    const bySource: CompiledChart['bySource'] = new Map()
    for (const [ordinal, compiled] of chart.notes.entries()) {
        const source = compiled.source
        if (!source) continue
        const order = orders.get(source.slideId) ?? 0
        orders.set(source.slideId, order + 1)
        bySource.set(source, { compiled, order, ordinal })
    }
    return { chart, bySource }
}
const compiledChart = computed((previous?: CompiledChart) => {
    const chart = buildChart(elevationState.value, settings.previewNoteSpeed)
    return previous?.chart === chart ? previous : indexChart(chart)
})
const gridNotes = computed(() => elevationState.value.store.grid.note)
// Selection-only states keep the layout, so rows aren't rebuilt for them.
const elevationComposed = computed(() => getComposedLayout(elevationState.value))
const bpms = computed(() => elevationState.value.bpms)
export const getElevationStageProps = (stageId: StageId, beat: number) => {
    const current = elevationState.value
    const chart = compiledChart.value.chart
    const index = [...current.stages.keys()].indexOf(stageId)
    const stage = current.isDynamicStages ? chart.stages[index] : undefined
    const props = stage ? getStageProps(stage, beatToTime(current.bpms, beat)) : { elevation: 0 }
    // Lanes follow the chart's layout: authored in Basic, offset by the stage in Composed.
    const layout = getComposedLayout(current)
    return {
        ...props,
        laneOffset: layout?.offset(stageId, beat) ?? 0,
        // The stage's lattice phase in authored lanes, as the chart snaps to it.
        gridOffset: layout?.gridOffset(stageId, beat) ?? 0,
    }
}
const everySecondLane = { size: 2, origin: 0, divider: 0 }
/** The selected stage's division size (2 without a pivot) and, in Composed, its snap lattice; else every second line. */
export const elevationStageGrid = computed(() => {
    const current = elevationState.value
    const stageId = view.stageId
    // Charts without dynamic stages compile none.
    const stage =
        stageId && compiledChart.value.chart.stages[[...current.stages.keys()].indexOf(stageId)]
    if (!stage) return { size: 2, lanes: everySecondLane }
    const beat = elevationBeat.value
    const { division } = getStageProps(stage, beatToTime(current.bpms, beat))
    const { size, parity } = dominantDivision(division)
    // Basic notes snap to whole lanes; the chart brightens every second one.
    const layout = getComposedLayout(current)
    if (!layout) return { size: size || 2, lanes: everySecondLane }
    const gridOffset = layout.gridOffset(stageId, beat)
    // As the chart draws them, the dividers start half a division past the pivot when odd.
    return {
        size: size || 2,
        lanes: {
            size: size || 2,
            origin: layout.offset(stageId, beat) + gridOffset,
            divider: (parity * size) / 2 - gridOffset,
        },
    }
})
const notesOf = (
    { chart, bySource }: CompiledChart,
    grid: State['store']['grid']['note'],
    bpms: State['bpms'],
    composed: ReturnType<typeof getComposedLayout>,
) => {
    const props = chart.stages.map((stage) =>
        getStageProps(stage, beatToTime(bpms, elevationBeat.value)),
    )
    const elevationOf = (note: PreviewNote) =>
        (note.elevation ?? 0) + (props[note.stageIndex]?.elevation ?? 0)
    const notes: ElevationNote[] = []
    const scope = scopeLookup.value
    const candidates = getNotesAtBeat(grid, elevationBeat.value).sort(
        (a, b) => (bySource.get(a)?.ordinal ?? 0) - (bySource.get(b)?.ordinal ?? 0),
    )
    for (const note of candidates) {
        const indexed = bySource.get(note)
        if (!indexed) continue
        const { order, compiled } = indexed
        // The elevation editor only shows editable notes: dimmed groups and
        // stages are omitted rather than drawn faintly.
        if (!view.visibilities.note || entityScopeVisibility(note, scope) !== 'full') continue
        let elevation = elevationOf(compiled)
        if (compiled.isAttached && compiled.attachHead && compiled.attachTail) {
            const head = elevationOf(compiled.attachHead)
            const tail = elevationOf(compiled.attachTail)
            const frac =
                (compiled.attachHead.source &&
                    compiled.attachTail.source &&
                    sameBeatAttachmentFraction(
                        compiled.attachHead.source,
                        compiled.attachTail.source,
                        note,
                    )) ??
                attachEasedFrac(compiled)
            elevation = head + (tail - head) * frac
        }
        // The same lanes as the chart beside it.
        const position = composed?.notePosition(note) ?? note
        notes.push({
            note,
            lane: position.left + position.size / 2,
            elevation,
            size: position.size,
            attached: compiled.isAttached,
            order,
        })
    }
    return notes
}
export const elevationNotes = computed(() =>
    notesOf(compiledChart.value, gridNotes.value, bpms.value, elevationComposed.value),
)
/** Whether a drag shows as ghosts over the committed notes: as on the chart, unless its scene is the preview. */
export const isElevationGhostDrag = computed(
    () =>
        !!previewEdit.value?.isDrag &&
        elevationState.value !== state.value &&
        !isScenePreview.value,
)
type CommittedChart = { state: State; noteSpeed: number; compiled: CompiledChart }
// The chart last compiled for committed data, kept through a drag for its ghosts to go over.
const committedChart = computed<CommittedChart | undefined>((previous) =>
    elevationState.value === state.value
        ? {
              state: state.value,
              noteSpeed: settings.previewNoteSpeed,
              compiled: compiledChart.value,
          }
        : previewEdit.value?.isDrag
          ? previous
          : undefined,
)
const committedNotes = computed(() => {
    const last = committedChart.value
    if (!isElevationGhostDrag.value) return
    const committed = state.value
    const noteSpeed = settings.previewNoteSpeed
    // Opened mid-drag, it compiles once, keeping nothing.
    const compiled =
        last && hasSameChartData(last.state, committed) && last.noteSpeed === noteSpeed
            ? last.compiled
            : indexChart(createPreviewChartBuilder()(committed, noteSpeed))
    return notesOf(
        compiled,
        committed.store.grid.note,
        committed.bpms,
        getComposedLayout(committed),
    )
})
// Pixels per lane: the chart's lane zoom, with a margin.
export const elevationLaneScale = computed(() => elevationBounds.w / (settings.width * 1.1))
const elevationAxes = computed(() => ({
    width: elevationBounds.w,
    height: elevationBounds.h,
    laneLeft: view.lane - (settings.width * 1.1) / 2,
    laneScale: elevationLaneScale.value,
    elevationCenter: elevationViewport.center,
    elevationScale: elevationViewport.scale,
}))
export const elevationLayout = computed(() =>
    layoutElevationNotes(elevationNotes.value, elevationAxes.value),
)
/** The committed rows under a drag's ghosts; otherwise the shown ones. */
export const committedElevationLayout = computed(() =>
    committedNotes.value
        ? layoutElevationNotes(committedNotes.value, elevationAxes.value)
        : elevationLayout.value,
)
const isSameRow = (a: ElevationRow, b: ElevationRow) =>
    a.attached === b.attached &&
    Math.abs(a.lane - b.lane) < 1e-7 &&
    Math.abs(a.size - b.size) < 1e-7 &&
    Math.abs(a.elevation - b.elevation) < 1e-7
/**
 * A ghost drag's rows as the chart draws it: committed ones solid, moved ones as ghosts,
 * and slides it changes beyond them, such as by shifting an attached tick, solid as they drop.
 */
export const elevationDragRows = computed(() => {
    const committed = committedElevationLayout.value
    const preview = elevationLayout.value
    if (committed === preview) return
    const before = new Map(committed.rows.map((row) => [row.note, row]))
    // A drag selects the notes it moves.
    const moved = new Set(elevationState.value.selectedEntities)
    // The chart's previewed slides, and those whose rows here change beyond the moved notes.
    const live = new Set<SlideId>(previewSlides.value?.slideIds)
    const isRetime = !isSameTempo(elevationState.value.bpms, state.value.bpms)
    // A retiming drag draws no slide live, as on the chart.
    if (!isRetime)
        for (const row of preview.rows) {
            const was = before.get(row.note)
            if (was ? !isSameRow(was, row) : !moved.has(row.note)) live.add(row.note.slideId)
        }
    const isLive = (row: ElevationRow) => live.has(row.note.slideId)
    // The chart draws a retime's ghosts on its committed lanes.
    const composed = isRetime ? getComposedLayout(state.value) : undefined
    const shown = composed
        ? layoutElevationNotes(
              notesOf(compiledChart.value, gridNotes.value, bpms.value, composed),
              elevationAxes.value,
          ).rows
        : preview.rows
    return {
        rows: [
            ...committed.rows.filter((row) => !isLive(row)),
            ...preview.rows.filter(isLive),
        ].sort((a, b) => a.elevation - b.elevation || a.order - b.order),
        // Only moved notes ghost, not ticks a retime rebuilds.
        ghosts: shown.filter((row) => moved.has(row.note) && !before.has(row.note) && !isLive(row)),
        live,
    }
})
