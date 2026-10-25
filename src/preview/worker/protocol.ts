import type { PreviewFrameInput } from '../drawFrame'
import type { PreviewParticle } from '../particle'
import type { PreviewSkin } from '../skin'
import type { MirrorDiff } from './mirror'

/** Test flags for the worker host's handover specs (`nse.test.previewWorker`). */
export type PreviewWorkerFlags = {
    /** The worker's WebGL2 context is unavailable. */
    noWebgl?: boolean
    /** The worker throws an error that no message handler catches. */
    throwOnStart?: boolean
    /** The worker throws while drawing this frame (1 is the first). */
    throwOnFrame?: number
    /** The worker never answers this frame. */
    hangOnFrame?: number
    /** How long the host waits for an answer, in ms. */
    timeoutMs?: number
}

/** Test counters, as the preview specs read them from `window.previewTest`. */
export type PreviewWorkerCounters = {
    uploads: number
    frames: number
    /** Renderers that released their context. */
    releases: number
    /** The last frame's vertices, once a frame cleared since the last report. */
    vertices?: number[]
    aspect?: number
}

export type ToPreviewWorker =
    | { type: 'start'; test: boolean; flags: PreviewWorkerFlags }
    /**
     * The preview's canvas, or none when the panel closes; the atlases stay. The canvas it
     * replaces keeps its context until `release`.
     */
    | { type: 'canvas'; canvas?: OffscreenCanvas; antialias: boolean }
    | { type: 'overlay'; canvas?: OffscreenCanvas }
    /** The page has drawn two frames without the canvases replaced so far. Release their contexts. */
    | { type: 'release' }
    | {
          type: 'atlas'
          slot: 0 | 1
          bitmap: ImageBitmap
          interpolation: boolean
          sprites: PreviewSkin | PreviewParticle
      }
    | {
          type: 'frame'
          mirror?: MirrorDiff
          /** The selection's places in the slides, sent when it or the slides changed. */
          selection?: { places: Int32Array; stages: number[] } | null
          input: PreviewFrameInput
      }
    /** Hand the atlases back to the main thread. The canvases stay until the worker is terminated. */
    | { type: 'return' }
    | { type: 'outlinePixels' }
    | { type: 'loseContext' }
    | { type: 'restoreContext' }

export type FromPreviewWorker =
    | { type: 'ready'; maxViewportSize: { width: number; height: number } }
    | { type: 'failed'; message: string }
    | { type: 'drawn'; ms: number }
    | { type: 'error'; message: string }
    | { type: 'atlases'; bitmaps: (ImageBitmap | undefined)[] }
    | { type: 'counters'; counters: PreviewWorkerCounters }
    | { type: 'outlinePixels'; lit: number }
    | { type: 'context'; lost: boolean }
