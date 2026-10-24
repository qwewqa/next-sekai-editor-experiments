import { computed, onBeforeUnmount, shallowRef, watch, watchEffect, type Ref } from 'vue'
import { isAppActive } from '../activity'
import { clearSurface } from '../editor/canvas/surface'
import { view } from '../editor/view'
import { dockSizeDrafts, panelWeightsDraft } from '../editor/workspace'
import { cancelFrame, requestFrame } from '../frame'
import { state } from '../history'
import { timed } from '../perf/probe'
import { isPlaying } from '../player'
import { disposeDrawContext } from '../rendering/context'
import { useEditorRenderer } from '../rendering/useEditorRenderer'
import { settings } from '../settings'
import type { State } from '../state'
import { hasSameChartData } from '../state/data'
import { getPreviewState, previewEdit } from './edit'
import { getPreviewChart } from './engine/chart'
import type { PreviewChart } from './engine/model'
import { renderPreviewFrame } from './engine/render'
import { createPreviewRenderer, type PreviewRenderer } from './gl'
import type { LoadedParticle } from './particle'
import { createSelectionOutline } from './selectionOutline'
import type { LoadedSkin } from './skin'
import type { usePreviewResources } from './usePreviewResources'

type PreviewViewport = {
    canvasWidth: Ref<number>
    canvasHeight: Ref<number>
    pixelRatio: Ref<number>
}

export const usePreviewRendering = (
    canvas: Readonly<Ref<HTMLCanvasElement | null>>,
    background: Readonly<Ref<HTMLDivElement | null>>,
    {
        skin,
        particle,
        background: loadedBackground,
        setGraphicsError,
        clearGraphicsError,
    }: ReturnType<typeof usePreviewResources>,
    { canvasWidth, canvasHeight, pixelRatio }: PreviewViewport,
    selectionCanvas?: Readonly<Ref<HTMLCanvasElement | null>>,
) => {
    // Selection, audio and filename changes share the same chart data. Keep them from
    // rebuilding the preview and its indexes during ordinary editor interactions.
    const chartState = computed<State>((previous) => {
        const next = state.value
        if (previous && hasSameChartData(previous, next)) {
            return previous
        }
        return next
    })
    // Capture changes cheaply, then resolve only the latest request when a visible
    // frame actually draws. Numeric input and pointer events may arrive repeatedly
    // before RAF; discarded requests never build a transaction or compile a chart.
    const chartRequest = computed(() => {
        const current = chartState.value
        const edit = previewEdit.value
        const speed = settings.previewNoteSpeed
        let chart: PreviewChart | undefined
        return () => (chart ??= getPreviewChart(getPreviewState(current, edit), speed))
    })

    // Playback redraws every frame; the selected objects and stages only change with the state.
    const selection = computed(() => {
        if (!settings.previewHighlightSelection) return
        const selected = getPreviewState(state.value).selectedEntities
        const objects = new Set<object>(selected)
        const stageIds = new Set(
            selected.flatMap((entity) => {
                if (entity.type === 'note' || entity.type === 'connector') return []
                if ('stageId' in entity) return [entity.stageId]
                if ('min' in entity && 'stageId' in entity.min) return [entity.min.stageId]
                return []
            }),
        )
        const stages = new Set(
            [...state.value.stages.keys()].flatMap((id, index) =>
                stageIds.has(id) ? [index] : [],
            ),
        )
        return objects.size || stages.size ? { objects, stages } : undefined
    })

    const renderer = shallowRef<PreviewRenderer>()

    let contextLost = false

    const initializeRenderer = () => {
        if (!isAppActive.value || !canvas.value || !skin.value || renderer.value || contextLost)
            return

        try {
            renderer.value = createPreviewRenderer(canvas.value, settings.previewAntialias)
            clearGraphicsError()
        } catch (error) {
            console.error('Failed to create preview renderer:', error)
            setGraphicsError(error)
        }
    }

    watch([skin, isAppActive], initializeRenderer)
    watch(canvas, (currentCanvas, _previousCanvas, onCleanup) => {
        renderer.value?.dispose()
        renderer.value = undefined
        contextLost = false
        if (!currentCanvas) return

        const onContextLost = (event: Event) => {
            // Opt in to restoration; all resources from the old context are invalid.
            event.preventDefault()
            contextLost = true
            const lostRenderer = renderer.value
            renderer.value = undefined
            // Release pooled CPU geometry too: restoration may be deferred indefinitely
            // on a backgrounded or memory-constrained device.
            lostRenderer?.dispose()
            uploadedRenderer = undefined
        }
        const onContextRestored = () => {
            contextLost = false
            initializeRenderer()
        }
        currentCanvas.addEventListener('webglcontextlost', onContextLost)
        currentCanvas.addEventListener('webglcontextrestored', onContextRestored)
        onCleanup(() => {
            currentCanvas.removeEventListener('webglcontextlost', onContextLost)
            currentCanvas.removeEventListener('webglcontextrestored', onContextRestored)
        })

        initializeRenderer()
    })

    let uploadedRenderer: PreviewRenderer | undefined
    let uploadedSkin: LoadedSkin | undefined
    let uploadedParticle: LoadedParticle | undefined
    watch(
        [renderer, skin, particle, isAppActive],
        ([nextRenderer, nextSkin, nextParticle, active]) => {
            if (!active || !nextRenderer) return

            try {
                if (nextSkin && (nextRenderer !== uploadedRenderer || nextSkin !== uploadedSkin)) {
                    nextRenderer.setTexture(0, nextSkin.texture, nextSkin.interpolation)
                    uploadedSkin = nextSkin
                }
                if (
                    nextParticle &&
                    (nextRenderer !== uploadedRenderer || nextParticle !== uploadedParticle)
                ) {
                    nextRenderer.setTexture(1, nextParticle.texture, nextParticle.interpolation)
                    uploadedParticle = nextParticle
                }
                uploadedRenderer = nextRenderer
            } catch (error) {
                console.error('Failed to upload preview textures:', error)
                setGraphicsError(error)
                renderer.value = undefined
                nextRenderer.dispose()
            }
        },
    )

    let rafId = 0
    let renderFrame: (() => void) | undefined
    let renderedBackground: HTMLDivElement | undefined
    let renderedBackgroundTransform = ''
    let scheduledSize: { width: number; height: number } | undefined
    // While a dock or tile is being dragged, keep the drawing buffers and let CSS
    // scale them: reallocating them on every pointer move was the costliest part
    // of a drag. The image keeps its aspect ratio, and releasing the handle
    // renders at full resolution again. Only the start and end of a drag redraw;
    // drafts for docks that leave the preview's size alone draw nothing.
    const isResizing = computed(
        () => panelWeightsDraft.value !== undefined || Object.keys(dockSizeDrafts.value).length > 0,
    )
    let sizedOverlay: HTMLCanvasElement | undefined
    let renderedOverlay: HTMLCanvasElement | undefined
    let drawnOverlay: HTMLCanvasElement | undefined
    const overlayVersion = shallowRef(0)
    const selectionRenderer = useEditorRenderer(setGraphicsError)
    if (selectionCanvas) {
        watch(selectionCanvas, (overlay, _previous, onCleanup) => {
            if (!overlay) return
            const restoreOverlay = () => {
                drawnOverlay = overlay
                overlayVersion.value++
            }
            overlay.addEventListener('renderingready', restoreOverlay)
            onCleanup(() => {
                selectionRenderer.forget(overlay)
                overlay.removeEventListener('renderingready', restoreOverlay)
                if (drawnOverlay === overlay) drawnOverlay = undefined
                if (renderedOverlay === overlay) renderedOverlay = undefined
                disposeDrawContext(overlay)
            })
        })
    }

    const getRenderSize = (requestedScale: number) => {
        if (!renderer.value) return

        const requestedWidth = canvasWidth.value * requestedScale
        const requestedHeight = canvasHeight.value * requestedScale
        const { width: maxWidth, height: maxHeight } = renderer.value.maxViewportSize
        const fit = Math.min(1, maxWidth / requestedWidth, maxHeight / requestedHeight)

        return {
            width: Math.max(1, Math.round(requestedWidth * fit)),
            height: Math.max(1, Math.round(requestedHeight * fit)),
        }
    }

    // Every animation uses chart time, so a paused frame only changes when one of
    // these inputs changes. Coalesce edits and playback updates into one draw.
    watchEffect(
        () => {
            if (!isAppActive.value) {
                cancelFrame(rafId)
                rafId = 0
                renderFrame = undefined
                return
            }
            const currentRenderer = renderer.value
            const currentSkin = skin.value
            if (!currentRenderer || !currentSkin || !canvasWidth.value || !canvasHeight.value) {
                renderFrame = undefined
                return
            }

            const fullSize = getRenderSize(pixelRatio.value * settings.previewRenderScale)
            if (!fullSize) return
            const resizing = isResizing.value
            const renderSize = resizing ? (scheduledSize ?? fullSize) : fullSize
            scheduledSize = renderSize

            const getChart = chartRequest.value
            const backgroundElement = background.value
            const backgroundLayout = loadedBackground.value
                ? {
                      aspectRatio: loadedBackground.value.aspectRatio,
                      fit: loadedBackground.value.fit,
                  }
                : undefined
            const selected = selection.value
            const overlay = selectionCanvas?.value
            void overlayVersion.value
            const leftLimit = !isPlaying.value
            // Only redraws: the overlay never changes the compiled chart.
            const showHitboxes = settings.previewShowHitboxes
            const args = [
                view.cursorTime,
                renderSize.width,
                renderSize.height,
                canvasWidth.value,
                canvasHeight.value,
                settings.previewNoteSpeed,
                settings.previewShowEffects,
                particle.value?.particle,
            ] as const
            renderFrame = () => {
                if (overlay) {
                    const ratio = pixelRatio.value
                    if (!resizing || overlay !== sizedOverlay) {
                        sizedOverlay = overlay
                        const width = Math.round(canvasWidth.value * ratio)
                        const height = Math.round(canvasHeight.value * ratio)
                        if (overlay.width !== width || overlay.height !== height) {
                            if (overlay.width !== width) overlay.width = width
                            if (overlay.height !== height) overlay.height = height
                            if (renderedOverlay === overlay) drawnOverlay = overlay
                        }
                    }
                }
                const outline = createSelectionOutline()
                const quad = renderPreviewFrame(
                    currentRenderer,
                    currentSkin.skin,
                    getChart(),
                    ...args,
                    selected
                        ? { ...selected, outline: outline.add, line: outline.addLine }
                        : undefined,
                    leftLimit,
                    showHitboxes,
                    backgroundLayout,
                )
                const edges = outline.edges()
                // Once empty, the overlay stays transparent. Avoid creating or
                // switching a second GL context on every unselected playback frame.
                if (overlay && (edges.length || drawnOverlay === overlay)) {
                    const ctx = selectionRenderer.getContext(overlay)
                    renderedOverlay = overlay
                    if (ctx && !ctx.isContextLost()) {
                        // Map CSS pixels onto the actual backing store, which keeps
                        // its size during a resize drag.
                        ctx.setTransform(
                            overlay.width / canvasWidth.value,
                            0,
                            0,
                            overlay.height / canvasHeight.value,
                            0,
                            0,
                        )
                        clearSurface(ctx, overlay.width, overlay.height)
                        if (edges.length) {
                            const scale = args[4] / 2
                            ctx.beginPath()
                            for (const { a, b } of edges) {
                                ctx.moveTo(args[3] / 2 + a.x * scale, args[4] / 2 - a.y * scale)
                                ctx.lineTo(args[3] / 2 + b.x * scale, args[4] / 2 - b.y * scale)
                            }
                            ctx.lineJoin = 'round'
                            ctx.lineCap = 'round'
                            ctx.strokeStyle = '#06151d'
                            ctx.lineWidth = 5
                            ctx.stroke()
                            ctx.strokeStyle = '#67e8f9'
                            ctx.lineWidth = 2
                            ctx.stroke()
                        }
                        ctx.flush()
                        drawnOverlay = edges.length ? overlay : undefined
                    }
                }
                if (!backgroundElement) return
                // Map the complete image into the engine's screen-space quad in
                // this same frame. CSS pixels have a downward-pointing y axis.
                const displayWidth = args[3]
                const displayHeight = args[4]
                const scale = displayHeight / 2
                const transform = `matrix(${[
                    ((quad.tr.x - quad.tl.x) * scale) / displayWidth,
                    (-(quad.tr.y - quad.tl.y) * scale) / displayWidth,
                    (quad.bl.x - quad.tl.x) / 2,
                    -(quad.bl.y - quad.tl.y) / 2,
                    displayWidth / 2 + quad.tl.x * scale,
                    displayHeight / 2 - quad.tl.y * scale,
                ].join(',')})`
                if (
                    renderedBackground !== backgroundElement ||
                    renderedBackgroundTransform !== transform
                ) {
                    backgroundElement.style.backgroundSize = '100% 100%'
                    backgroundElement.style.transform = transform
                    renderedBackground = backgroundElement
                    renderedBackgroundTransform = transform
                }
            }
            if (rafId) return
            rafId = requestFrame(
                timed('previewDraw', () => {
                    rafId = 0
                    if (isAppActive.value) renderFrame?.()
                }),
            )
        },
        { flush: 'post' },
    )

    onBeforeUnmount(() => {
        cancelFrame(rafId)
        renderer.value?.dispose()
    })
}
