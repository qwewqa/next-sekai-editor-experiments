import { computed, onScopeDispose, watch, type Ref } from 'vue'
import { backingSize, type MinimapMapping } from './mapping'
import { minimapStats, sameBaseline, type Baseline } from './pipeline'

// The strip's mark layers: one canvas each over the content, with its own inputs, schedule and
// counter, so one kind of mark never repaints another.

/** One kind of mark drawn over the strip's content, on a canvas of its own. */
export type MinimapLayer<T> = {
    /** Created in the layer's scope. While it is undefined, nothing is drawn and the canvas is removed. */
    useInputs: () => Readonly<Ref<T | undefined>>
    /** Draws in CSS px; the canvas is clear. */
    paint: (ctx: CanvasRenderingContext2D, mapping: MinimapMapping, inputs: T) => void
    counter: 'changePaints' | 'selectionPaints'
    /**
     * Whether the content's front image is one the marks fit: they then paint only on such an
     * image, and hide while it differs.
     */
    aligned: (drawn: Baseline, mapping: MinimapMapping) => boolean
}

/** What a gated layer last painted with. Its backing size follows from the baseline's geometry. */
type Painted = { inputs: unknown; drawn: Baseline }

const samePainted = (a: Painted, b: Painted) =>
    a.inputs === b.inputs && sameBaseline(a.drawn, b.drawn)

/**
 * Paints `layer` on `canvas` in a component's setup: in the frame the content's image changes, or
 * one frame after its inputs or the mapping change, and only while that image fits the marks.
 * Returns whether the layer has marks to draw.
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

    /** A paint on a fitting image only, and none when nothing differs. */
    const paintAligned = () => {
        const element = canvas.value
        const current = mapping.value
        const baseline = drawn.value
        const value = inputs.value
        if (!element || !current || value === undefined) return
        if (!baseline || !layer.aligned(baseline, current)) return
        const target = { inputs: value, drawn: baseline }
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

    const requestPaint = () => {
        if (frame !== undefined) return
        frame = requestAnimationFrame(() => {
            frame = undefined
            paintAligned()
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

    watch(
        drawn,
        (baseline) => {
            const element = canvas.value
            const current = mapping.value
            if (!element || !current) return
            // The image under the marks changed to one they were not painted for.
            if (!baseline || !layer.aligned(baseline, current)) element.style.visibility = 'hidden'
            else paintAligned()
        },
        { flush: 'post' },
    )
    watch([inputs, mapping, canvas], requestPaint, { flush: 'post' })

    onScopeDispose(() => {
        cancelFrame()
        const element = canvas.value
        if (!element) return
        element.removeEventListener('contextlost', onContextChange)
        element.removeEventListener('contextrestored', onContextChange)
        element.width = element.height = 0
    })

    return { active }
}
