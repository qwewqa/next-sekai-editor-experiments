import { computed } from 'vue'
import type { StageId } from '../../chart/stages'
import { state } from '../../history'
import { getPreviewState, previewEdit } from '../../preview/edit'
import { attachEasedFrac, createPreviewChartBuilder } from '../../preview/engine/chart'
import type { PreviewNote } from '../../preview/engine/model'
import { getStageProps } from '../../preview/engine/stage'
import { settings } from '../../settings'
import { sameBeatAttachmentFraction } from '../../state/entities/slides/attachment'
import type { NoteEntity } from '../../state/entities/slides/note'
import { beatToTime } from '../../state/integrals/bpms'
import { getComposedLayout } from '../composedView'
import { scopeLookup } from '../scope'
import { entityScopeVisibility } from '../scopeRules'
import { view } from '../view'
import { getNotesAtBeat } from './candidates'
import { layoutElevationNotes, type ElevationNote } from './layout'
import { elevationBeat } from './state'
import { elevationBounds, elevationViewport } from './viewport'

const buildChart = createPreviewChartBuilder()
export const elevationState = computed(() => getPreviewState(state.value, previewEdit.value))
const compileChart = () => {
    const chart = buildChart(elevationState.value, settings.previewNoteSpeed)
    const orders = new Map<NoteEntity['slideId'], number>()
    const bySource = new Map<
        NoteEntity,
        { compiled: PreviewNote; order: number; ordinal: number }
    >()
    for (const [ordinal, compiled] of chart.notes.entries()) {
        const source = compiled.source
        if (!source) continue
        const order = orders.get(source.slideId) ?? 0
        orders.set(source.slideId, order + 1)
        bySource.set(source, { compiled, order, ordinal })
    }
    return { chart, bySource }
}
const compiledChart = computed((previous?: ReturnType<typeof compileChart>) => {
    const chart = buildChart(elevationState.value, settings.previewNoteSpeed)
    return previous?.chart === chart ? previous : compileChart()
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
export const elevationNotes = computed(() => {
    const { chart, bySource } = compiledChart.value
    const props = chart.stages.map((stage) =>
        getStageProps(stage, beatToTime(bpms.value, elevationBeat.value)),
    )
    const composed = elevationComposed.value
    const elevationOf = (note: PreviewNote) =>
        (note.elevation ?? 0) + (props[note.stageIndex]?.elevation ?? 0)
    const notes: ElevationNote[] = []
    const scope = scopeLookup.value
    const candidates = getNotesAtBeat(gridNotes.value, elevationBeat.value).sort(
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
})
export const elevationLayout = computed(() => {
    const width = settings.width * 1.1
    return layoutElevationNotes(elevationNotes.value, {
        width: elevationBounds.w,
        height: elevationBounds.h,
        laneLeft: view.lane - width / 2,
        laneScale: elevationBounds.w / width,
        elevationCenter: elevationViewport.center,
        elevationScale: elevationViewport.scale,
    })
})
