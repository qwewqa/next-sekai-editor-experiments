import { computed, onScopeDispose, watch, type Ref } from 'vue'
import { isSameTempo } from '../../state/integrals/bpms'
import { backingSize, type MinimapMapping } from './mapping'
import { minimapStats, sameGeometry, type Baseline } from './pipeline'

// The strip's mark layers: one canvas each over the content, with its own inputs, schedule and
// counter, so one kind of mark never repaints another.

/** One kind of mark drawn over the strip's content, on a canvas of its own. */
export type MinimapLayer<T> = {
    /** The canvas's `data-minimap-layer`. */
    name: string
    /** Created in the layer's scope. While it is undefined, nothing is drawn and the canvas is removed. */
    useInputs: () => Readonly<Ref<T | undefined>>
    /** Draws in CSS px; the canvas is clear. */
    paint: (ctx: CanvasRenderingContext2D, mapping: MinimapMapping, inputs: T) => void
    counter: 'annotationPaints' | 'selectionPaints'
    /**
     * Set for marks drawn on the notes: whether the content's front image is the one the marks
     * are for. They then paint only on that image, and hide while it differs.
     */
    aligned?: (drawn: Baseline, mapping: MinimapMapping) => boolean
}

/** What a gated layer last painted with. */
type Painted = {
    inputs: unknown
    drawn: Baseline
    width: number
    height: number
}

const samePainted = (a: Painted, b: Painted) =>
    a.inputs === b.inputs &&
    a.drawn.grids.note === b.drawn.grids.note &&
    isSameTempo(a.drawn.bpms, b.drawn.bpms) &&
    a.drawn.layoutKey === b.drawn.layoutKey &&
    a.drawn.end === b.drawn.end &&
    sameGeometry(a.drawn.geometry, b.drawn.geometry) &&
    a.width === b.width &&
    a.height === b.height

/**
 * Paints `layer` on `canvas` in a component's setup. An ungated layer paints after the flush of
 * any change to its inputs or the mapping. A gated one paints in the frame the content's image
 * changes, or one frame after its inputs or the mapping change, and only while that image matches
 * the state. Returns whether the layer has marks to draw.
 */
export const useMinimapLayer = <T>(
    canvas: Readonly<Ref<HTMLCanvasElement | null | undefined>>,
    mapping: Readonly<Ref<MinimapMapping | undefined>>,
    drawn: Readonly<Ref<Baseline | undefined>>,
    layer: MinimapLayer<T>,
) => {
    const inputs = layer.useInputs()
    const active = computed(() => inputs.value !== undefined)
    let painted: Painted | undefined
    let frame: number | undefined

    const draw = (element: HTMLCanvasElement, current: MinimapMapping, value: T) => {
        const size = backingSize(current.geometry)
        if (element.width !== size.width) element.width = size.width
        if (element.height !== size.height) element.height = size.height
        const ctx = element.getContext('2d', { willReadFrequently: true })
        if (!ctx) return false
        ctx.setTransform(
            size.width / current.geometry.width,
            0,
            0,
            size.height / current.geometry.height,
            0,
            0,
        )
        ctx.clearRect(0, 0, current.geometry.width, current.geometry.height)
        layer.paint(ctx, current, value)
        minimapStats[layer.counter]++
        return true
    }

    /** A gated paint: on the matching image only, and none when nothing differs. */
    const paintAligned = () => {
        const element = canvas.value
        const current = mapping.value
        const baseline = drawn.value
        const value = inputs.value
        if (!element || !current || value === undefined || !layer.aligned) return
        if (!baseline || !layer.aligned(baseline, current)) return
        const target = { inputs: value, drawn: baseline, ...backingSize(current.geometry) }
        if (!painted || !samePainted(painted, target)) {
            if (!draw(element, current, value)) return
            painted = target
        }
        element.style.visibility = ''
    }

    const cancelFrame = () => {
        if (frame !== undefined) cancelAnimationFrame(frame)
        frame = undefined
    }

    /** An ungated paint, whenever there is something to draw. */
    const paintPlain = () => {
        const element = canvas.value
        const current = mapping.value
        const value = inputs.value
        if (element && current && value !== undefined) draw(element, current, value)
    }

    const requestPaint = () => {
        if (frame !== undefined) return
        frame = requestAnimationFrame(() => {
            frame = undefined
            if (layer.aligned) paintAligned()
            else paintPlain()
        })
    }

    // After a lost context is restored, the canvas is blank.
    const onContextChange = (event: Event) => {
        painted = undefined
        if (event.type === 'contextrestored') requestPaint()
    }

    watch(
        canvas,
        (element, previous) => {
            painted = undefined
            if (previous && previous !== element) {
                previous.removeEventListener('contextlost', onContextChange)
                previous.removeEventListener('contextrestored', onContextChange)
                previous.width = previous.height = 0
            }
            if (!element) {
                cancelFrame()
                return
            }
            element.addEventListener('contextlost', onContextChange)
            element.addEventListener('contextrestored', onContextChange)
        },
        { flush: 'post' },
    )

    if (layer.aligned) {
        const aligned = layer.aligned
        watch(
            drawn,
            (baseline) => {
                const element = canvas.value
                const current = mapping.value
                if (!element || !current) return
                // The image under the marks changed to one they were not painted for.
                if (!baseline || !aligned(baseline, current)) element.style.visibility = 'hidden'
                else paintAligned()
            },
            { flush: 'post' },
        )
        watch([inputs, mapping, canvas], requestPaint, { flush: 'post' })
    } else {
        watch([inputs, mapping, canvas], paintPlain, { flush: 'post' })
    }

    onScopeDispose(() => {
        cancelFrame()
        const element = canvas.value
        if (element) element.width = element.height = 0
    })

    return { active }
}
