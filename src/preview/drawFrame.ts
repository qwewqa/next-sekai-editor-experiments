import type { BackgroundFit } from './engine/background'
import type { PreviewChart } from './engine/model'
import { renderPreviewFrame } from './engine/render'
import type { PreviewRenderer } from './gl'
import { markerSegments, outlineSegments, type OutlineRenderer } from './outlineRenderer'
import type { PreviewParticle } from './particle'
import { createSelectionOutline } from './selectionOutline'
import type { PreviewSkin } from './skin'

/** What one preview frame draws, apart from the chart and the selection. */
export type PreviewFrameInput = {
    time: number
    /** Paused frames show the instant before `time`. */
    leftLimit: boolean
    /** The drawing buffer. */
    width: number
    height: number
    /** The panel, in CSS pixels. */
    displayWidth: number
    displayHeight: number
    /** The outline's backing store, which keeps its size during a resize drag. */
    overlayWidth: number
    overlayHeight: number
    noteSpeed: number
    showEffects: boolean
    showHitboxes: boolean
    background?: { aspectRatio: number; fit: BackgroundFit }
}

export type PreviewSelection = {
    objects: ReadonlySet<object>
    stages: ReadonlySet<number>
    /** Stages with a selected transform event, which mark their rotation center. */
    centers: ReadonlySet<number>
}

/** Draws a frame, its selection outline and markers; returns the quad the background image fills. */
export const drawPreviewFrame = (
    renderer: PreviewRenderer,
    outline: OutlineRenderer | undefined,
    skin: PreviewSkin,
    particle: PreviewParticle | undefined,
    chart: PreviewChart,
    input: PreviewFrameInput,
    selection: PreviewSelection | undefined,
) => {
    const edges = createSelectionOutline()
    const quad = renderPreviewFrame(
        renderer,
        skin,
        chart,
        input.time,
        input.width,
        input.height,
        input.displayWidth,
        input.displayHeight,
        input.noteSpeed,
        input.showEffects,
        particle,
        selection && {
            ...selection,
            outline: edges.add,
            line: edges.addLine,
            marker: edges.addMarker,
        },
        input.leftLimit,
        input.showHitboxes,
        input.background,
    )
    outline?.draw(
        outlineSegments(edges.edges(), input.displayWidth, input.displayHeight),
        markerSegments(edges.markers(), input.displayWidth, input.displayHeight),
        input.overlayWidth,
        input.overlayHeight,
        input.overlayWidth / input.displayWidth,
        input.overlayHeight / input.displayHeight,
    )
    return quad
}
