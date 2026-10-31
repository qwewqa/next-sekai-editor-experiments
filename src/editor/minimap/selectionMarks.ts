import { computed } from 'vue'
import { state } from '../../history'
import { timed } from '../../perf/probe'
import type { State } from '../../state'
import type { Entity, EntityType } from '../../state/entities'
import { beatToTime, type BpmIntegral } from '../../state/integrals/bpms'
import { SELECTION_COLOR } from '../../utils/colors'
import type { ComposedLayout } from '../composed'
import { getComposedLayout } from '../composedView'
import { gridsOf } from './diff'
import type { MinimapLayer } from './layers'
import { MAX_BACKING_HEIGHT, gutterMarkEdges, type MinimapMapping } from './mapping'
import { FAKE_FACTOR, noteRect } from './paint'
import { layoutKeyOf, sameBaseline, type Baseline } from './pipeline'
import { createRowSpread } from './tickRuns'

// The shown state's selection on the strip: each selected note drawn again in white over its own
// mark (the lift), and a cyan rail at the right edge for each run of selected rows, which also
// marks the selected objects the strip does not draw.

const LIFT_COLOR = '#ffffff'

/** What the rail marks. Connectors and event connections are left out, as the chart's rows are. */
const MARKED = new Set<EntityType>([
    'note',
    'bpm',
    'timeScale',
    'cameraEventJoint',
    'stageMaskEventJoint',
    'stagePivotEventJoint',
    'stageStyleEventJoint',
    'stageTransformEventJoint',
])

type SelectionInputs = {
    entities: readonly Entity[]
    bpms: BpmIntegral[]
    layout: ComposedLayout | undefined
}

/** Whether the content's front image is the one `shown` and `mapping` describe. */
const matches = (drawn: Baseline, shown: State, mapping: MinimapMapping) =>
    sameBaseline(drawn, {
        grids: gridsOf(shown),
        bpms: shown.bpms,
        layoutKey: layoutKeyOf(getComposedLayout(shown)),
        end: mapping.end,
        geometry: mapping.geometry,
    })

let spread: ReturnType<typeof createRowSpread> | undefined

/** One pass over the selection for both marks. */
const paintSelection = timed(
    'minimapSelection',
    (ctx: CanvasRenderingContext2D, mapping: MinimapMapping, inputs: SelectionInputs) => {
        const { entities, bpms, layout } = inputs
        const { scale } = mapping.geometry
        spread ??= createRowSpread(MAX_BACKING_HEIGHT + 1)
        spread.reset(scale)
        const solid = new Path2D()
        const faint = new Path2D()
        for (const entity of entities) {
            const note = entity.type === 'note'
            if (!note && !MARKED.has(entity.type)) continue
            const y = mapping.timeToY(beatToTime(bpms, entity.beat))
            spread.add(y)
            if (!note || entity.noteType === 'anchor') continue
            const rect = noteRect(entity, y, layout, mapping)
            ;(entity.isFake ? faint : solid).rect(rect.x, rect.y, rect.width, rect.height)
        }
        // The lift in device px, on the content's own pixels.
        ctx.save()
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.fillStyle = LIFT_COLOR
        ctx.fill(solid)
        ctx.globalAlpha = FAKE_FACTOR
        ctx.fill(faint)
        ctx.restore()
        ctx.fillStyle = SELECTION_COLOR
        const { rail } = gutterMarkEdges(mapping.geometry)
        const width = mapping.geometry.width - rail
        spread.runs((top, height) => {
            ctx.fillRect(rail, top, width, height)
        })
    },
)

export const selectionMarks: MinimapLayer<SelectionInputs> = {
    // Kept while the selection, the tempo and the layout keep their identities, so other state
    // changes paint nothing.
    useInputs: () =>
        computed<SelectionInputs | undefined>((previous) => {
            const shown = state.value
            const entities = shown.selectedEntities
            if (!entities.length) return undefined
            const layout = getComposedLayout(shown)
            if (
                previous?.entities === entities &&
                previous.bpms === shown.bpms &&
                previous.layout === layout
            )
                return previous
            return { entities, bpms: shown.bpms, layout }
        }),
    paint: paintSelection,
    counter: 'selectionPaints',
    aligned: (drawn, mapping) => matches(drawn, state.value, mapping),
}
