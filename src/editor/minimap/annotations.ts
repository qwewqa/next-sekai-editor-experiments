import type { MinimapMapping } from './mapping'

/** One kind of mark drawn over the strip's content (Part 1 §1.4.22). */
export type MinimapAnnotation<T> = {
    /** Reactive read of what to draw; undefined draws nothing. Compared by identity. */
    inputs: () => T | undefined
    paint: (ctx: CanvasRenderingContext2D, mapping: MinimapMapping, inputs: T) => void
}
