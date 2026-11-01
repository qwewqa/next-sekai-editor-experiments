import type { BackgroundFit } from './engine/background'
import type { Quad } from './engine/math'
import type { PreviewChart } from './engine/model'
import { previewBackgroundQuad, renderPreviewFrame } from './engine/render'
import type { PreviewSurface } from './gl'
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
    showCombo: boolean
    backdrop?: readonly [number, number, number]
    background?: {
        aspectRatio: number
        fit: BackgroundFit
        color: string
        blur: number
        mask?: string
    }
}

export type PreviewSelection = {
    objects: ReadonlySet<object>
    stages: ReadonlySet<number>
    /** Stages with a selected transform event, which mark their rotation center. */
    centers: ReadonlySet<number>
}

type FrameFailure = 'context' | 'resources' | 'size' | 'error'

export type PreviewFrameResult =
    | { drawn: true; backgroundQuad: Quad }
    | { drawn: false; reason: FrameFailure; backgroundQuad: Quad }

/** Draws the foreground, composites it over the background, then draws the selection. */
export const drawPreviewFrame = (
    renderer: PreviewSurface,
    outline: OutlineRenderer | undefined,
    skin: PreviewSkin | undefined,
    particle: PreviewParticle | undefined,
    chart: PreviewChart,
    input: PreviewFrameInput,
    selection: PreviewSelection | undefined,
): PreviewFrameResult => {
    const failed = (reason: FrameFailure): PreviewFrameResult => ({
        drawn: false,
        reason,
        backgroundQuad: previewBackgroundQuad(
            chart.isDynamicStages ? chart.cameras : [],
            input.time,
            input.displayWidth,
            input.displayHeight,
            input.leftLimit,
            input.background,
        ),
    })
    if (renderer.isContextLost()) return failed('context')
    if (!skin) return failed('resources')
    // The hosts still draw while replacement atlases load, but this is not a complete frame.
    const resourcesReady =
        renderer.hasTexture(0) &&
        (!input.showEffects || !particle || renderer.hasTexture(1)) &&
        (!input.background || renderer.hasTexture(3))
    if (
        ![input.width, input.height].every((size) => Number.isInteger(size) && size > 0) ||
        ![input.displayWidth, input.displayHeight].every(
            (size) => Number.isFinite(size) && size > 0,
        ) ||
        input.width > renderer.maxViewportSize.width ||
        input.height > renderer.maxViewportSize.height
    )
        return failed('size')
    try {
        renderer.prepareFrame(input.width, input.height)
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
            input.showCombo,
        )
        renderer.compositeBackground(quad, input)
        outline?.draw(
            outlineSegments(edges.edges(), input.displayWidth, input.displayHeight),
            markerSegments(edges.markers(), input.displayWidth, input.displayHeight),
            input.overlayWidth,
            input.overlayHeight,
            input.overlayWidth / input.displayWidth,
            input.overlayHeight / input.displayHeight,
        )
        if (renderer.isContextLost()) return failed('context')
        if (!resourcesReady) return { drawn: false, reason: 'resources', backgroundQuad: quad }
        return { drawn: true, backgroundQuad: quad }
    } catch {
        return failed(renderer.isContextLost() ? 'context' : 'error')
    }
}
