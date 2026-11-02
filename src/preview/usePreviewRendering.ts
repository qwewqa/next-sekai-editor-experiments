import { computed, onBeforeUnmount, shallowRef, watch, watchEffect, type Ref } from 'vue'
import { isAppActive } from '../activity'
import type { StageId } from '../chart/stages'
import { view } from '../editor/view'
import { dockSizeDrafts, panelWeightsDraft } from '../editor/workspace'
import { cancelFrame, requestFrame } from '../frame'
import { state } from '../history'
import { timed } from '../perf/probe'
import { isPlaying } from '../player'
import { settings } from '../settings'
import type { State } from '../state'
import { hasSameChartData } from '../state/data'
import { theme } from '../theme'
import type { LoadedBackground } from './assets/types'
import { readPreviewBackdrop } from './backdrop'
import { drawPreviewFrame, type PreviewFrameInput } from './drawFrame'
import { getPreviewState, previewEdit } from './edit'
import { getPreviewChart } from './engine/chart'
import { readCombo } from './engine/comboDraw'
import type { PreviewChart } from './engine/model'
import { createPreviewRenderer, type PreviewSurface } from './gl'
import { createOutlineRenderer, type OutlineRenderer } from './outlineRenderer'
import type { LoadedParticle } from './particle'
import { exposePreviewTest } from './previewTest'
import type { LoadedSkin } from './skin'
import type { usePreviewResources } from './usePreviewResources'
import { previewHost, previewWorker } from './worker/host'

type PreviewViewport = {
    canvasWidth: Ref<number>
    canvasHeight: Ref<number>
    pixelRatio: Ref<number>
}

type CanvasRef = Readonly<Ref<HTMLCanvasElement | null>>

/**
 * Draws the preview in one of two hosts. The main host draws on this thread, into `canvas` and
 * `selection`. The worker host transfers `workerCanvas` and `workerSelection` to the preview's
 * worker and posts each frame there. Either way, this decides what each frame shows.
 */
export const usePreviewRendering = (
    {
        canvas,
        selection: selectionCanvas,
        workerCanvas,
        workerSelection,
    }: {
        canvas: CanvasRef
        selection: CanvasRef
        workerCanvas: CanvasRef
        workerSelection: CanvasRef
    },
    {
        skin,
        particle,
        background: loadedBackground,
        setGraphicsError,
        clearGraphicsError,
    }: ReturnType<typeof usePreviewResources>,
    { canvasWidth, canvasHeight, pixelRatio }: PreviewViewport,
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
    const stateRequest = computed(() => {
        const current = chartState.value
        const edit = previewEdit.value
        let resolved: State | undefined
        return () => (resolved ??= getPreviewState(current, edit))
    })
    const chartRequest = computed(() => {
        const getState = stateRequest.value
        const speed = settings.previewNoteSpeed
        let chart: PreviewChart | undefined
        return () => (chart ??= getPreviewChart(getState(), speed))
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
        const centerIds = new Set(
            selected.flatMap((entity) =>
                entity.type === 'stageTransformEventJoint' ? [entity.stageId] : [],
            ),
        )
        const indices = (ids: ReadonlySet<StageId>) =>
            new Set(
                [...state.value.stages.keys()].flatMap((id, index) => (ids.has(id) ? [index] : [])),
            )
        const stages = indices(stageIds)
        return objects.size || stages.size
            ? { objects, stages, centers: indices(centerIds) }
            : undefined
    })

    const renderer = shallowRef<PreviewSurface>()
    const hasFrame = shallowRef(false)
    const backdrop = shallowRef<readonly [number, number, number]>()
    watch(
        theme,
        () => {
            backdrop.value = readPreviewBackdrop()
        },
        { immediate: true },
    )

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

    let uploadedRenderer: PreviewSurface | undefined
    let uploadedSkin: LoadedSkin | undefined
    let uploadedParticle: LoadedParticle | undefined
    let uploadedBackground: LoadedBackground | undefined
    watch(
        [renderer, skin, particle, loadedBackground, isAppActive],
        ([nextRenderer, nextSkin, nextParticle, nextBackground, active]) => {
            if (!active || !nextRenderer) return

            try {
                // A bitmap moved to the worker is detached, with no size, until it comes back or
                // is decoded again.
                if (
                    nextSkin?.texture.width &&
                    (nextRenderer !== uploadedRenderer || nextSkin !== uploadedSkin)
                ) {
                    nextRenderer.setTexture(0, nextSkin.texture, nextSkin.interpolation)
                    uploadedSkin = nextSkin
                }
                if (
                    nextParticle?.texture.width &&
                    (nextRenderer !== uploadedRenderer || nextParticle !== uploadedParticle)
                ) {
                    nextRenderer.setTexture(1, nextParticle.texture, nextParticle.interpolation)
                    uploadedParticle = nextParticle
                }
                if (
                    nextBackground?.texture.width &&
                    (nextRenderer !== uploadedRenderer || nextBackground !== uploadedBackground)
                ) {
                    nextRenderer.setTexture(3, nextBackground.texture, true)
                    uploadedBackground = nextBackground
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

    // The outline draws into its own canvas, and creates its context only once something is
    // selected. It redraws its last frame itself after a context loss.
    const outline = shallowRef<OutlineRenderer>()
    watch(selectionCanvas, (overlay, _previous, onCleanup) => {
        if (!overlay) return
        const outlineRenderer = createOutlineRenderer(overlay, (error) => {
            console.error('Failed to create the selection outline renderer:', error)
            setGraphicsError(error)
        })
        outline.value = outlineRenderer
        onCleanup(() => {
            outlineRenderer.dispose()
            if (outline.value === outlineRenderer) outline.value = undefined
        })
    })

    // The worker host: the page's worker keeps the atlases; each panel lends it its canvases.
    const worker = computed(() => (previewHost.kind === 'worker' ? previewWorker() : undefined))
    // As on the main thread, a new canvas gets its context once the app is active.
    let lentCanvas: HTMLCanvasElement | undefined
    let takeCanvas: (() => void) | undefined
    watch([workerCanvas, worker, isAppActive], ([element, host, active]) => {
        if (element === lentCanvas) return
        takeCanvas?.()
        takeCanvas = undefined
        lentCanvas = undefined
        if (!element || !host || !active) return
        takeCanvas = host.attachCanvas(element, settings.previewAntialias)
        lentCanvas = element
    })
    watch(workerSelection, (element, _previous, onCleanup) => {
        const host = worker.value
        if (element && host) onCleanup(host.attachOverlay(element))
    })
    watch(
        [worker, skin, particle, loadedBackground],
        ([host, nextSkin, nextParticle, nextBackground]) => {
            if (!host) return
            if (nextSkin) host.lendAtlas(0, nextSkin)
            if (nextParticle) host.lendAtlas(1, nextParticle)
            if (nextBackground) host.lendAtlas(3, nextBackground)
        },
        { immediate: true },
    )

    let rafId = 0
    let renderFrame: (() => void) | undefined
    let scheduledSize: { width: number; height: number } | undefined
    let backgroundDisplayHeight: number | undefined
    let overlaySize: { width: number; height: number } | undefined
    // While a dock or tile is being dragged, keep the drawing buffers and let CSS
    // scale them: reallocating them on every pointer move was the costliest part
    // of a drag. The image keeps its aspect ratio, and releasing the handle
    // renders at full resolution again. Only the start and end of a drag redraw;
    // drafts for docks that leave the preview's size alone draw nothing.
    const isResizing = computed(
        () => panelWeightsDraft.value !== undefined || Object.keys(dockSizeDrafts.value).length > 0,
    )

    const getRenderSize = (
        { width: maxWidth, height: maxHeight }: { width: number; height: number },
        requestedScale: number,
    ) => {
        const requestedWidth = canvasWidth.value * requestedScale
        const requestedHeight = canvasHeight.value * requestedScale
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
            const host = worker.value
            const currentRenderer = renderer.value
            const currentSkin = skin.value
            // The worker host draws once the worker has a context for the panel's canvas.
            const limits = host
                ? workerCanvas.value && host.maxViewportSize.value
                : currentRenderer?.maxViewportSize
            if (!limits || !currentSkin || !canvasWidth.value || !canvasHeight.value) {
                renderFrame = undefined
                return
            }

            const fullSize = getRenderSize(limits, pixelRatio.value * settings.previewRenderScale)
            const resizing = isResizing.value
            const renderSize = resizing ? (scheduledSize ?? fullSize) : fullSize
            scheduledSize = renderSize
            // Keep the blur's working pixels while CSS scales the held drawing buffer.
            if (!resizing || backgroundDisplayHeight === undefined)
                backgroundDisplayHeight = canvasHeight.value
            // The outline's backing store is kept the same way.
            const fullOverlaySize = {
                width: Math.round(canvasWidth.value * pixelRatio.value),
                height: Math.round(canvasHeight.value * pixelRatio.value),
            }
            const currentOverlaySize = resizing ? (overlaySize ?? fullOverlaySize) : fullOverlaySize
            overlaySize = currentOverlaySize

            const getState = stateRequest.value
            const getChart = chartRequest.value
            const input: PreviewFrameInput = {
                time: view.cursorTime,
                leftLimit: !isPlaying.value,
                width: renderSize.width,
                height: renderSize.height,
                displayWidth: canvasWidth.value,
                displayHeight: canvasHeight.value,
                overlayWidth: currentOverlaySize.width,
                overlayHeight: currentOverlaySize.height,
                noteSpeed: settings.previewNoteSpeed,
                showEffects: settings.previewShowEffects,
                // Only redraws: the overlay never changes the compiled chart.
                showHitboxes: settings.previewShowHitboxes,
                showCombo: settings.previewShowCombo,
                backdrop: backdrop.value,
                background: loadedBackground.value
                    ? {
                          aspectRatio: loadedBackground.value.aspectRatio,
                          fit: loadedBackground.value.fit,
                          color: loadedBackground.value.color,
                          sigma:
                              (loadedBackground.value.blur * renderSize.height) /
                              backgroundDisplayHeight,
                          mask: loadedBackground.value.mask,
                      }
                    : undefined,
            }
            const selected = selection.value
            const currentOutline = outline.value
            const currentParticle = particle.value?.particle
            renderFrame = host
                ? () => {
                      host.request(() => {
                          const state = getState()
                          host.post(state, selected, input)
                      })
                  }
                : () => {
                      if (!currentRenderer) return
                      const result = drawPreviewFrame(
                          currentRenderer,
                          currentOutline,
                          currentSkin.skin,
                          currentParticle,
                          getChart(),
                          input,
                          selected,
                      )
                      if (result.drawn) hasFrame.value = true
                      // The worker's last frame shows until the main host draws with the skin,
                      // which may still be decoding again after a handover.
                      if (
                          currentSkin.texture.width &&
                          uploadedRenderer === currentRenderer &&
                          uploadedSkin === currentSkin
                      )
                          previewHost.retiring = false
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

    const hideTest = exposePreviewTest({
        get host() {
            return previewHost.kind
        },
        outlineAlpha: () => worker.value?.outlineAlpha() ?? Promise.resolve(outline.value?.alpha()),
        comboPixels: () => {
            const host = worker.value
            if (host) return host.comboPixels()
            // The main host draws in this task, so the frame can still be read.
            renderFrame?.()
            return Promise.resolve(renderer.value && readCombo(renderer.value))
        },
        settled: () => worker.value?.settled() ?? Promise.resolve(),
        setContextLost: (lost) => worker.value?.setContextLost(lost) ?? Promise.resolve(),
    })

    watch(
        () => worker.value?.hasFrame.value,
        (drawn) => {
            if (drawn) hasFrame.value = true
        },
    )

    onBeforeUnmount(() => {
        cancelFrame(rafId)
        renderer.value?.dispose()
        takeCanvas?.()
        hideTest()
    })
    return { hasFrame }
}
