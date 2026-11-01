import type { ExportFailure } from './error'
import type { GraphicsLimits } from './graphics'
import type { AudioBlock } from './timing'
import type { ExportSettings, ExportStart, ExportTarget } from './types'

export type ExportFaults = {
    failWrite?: boolean
    loseContextAt?: number
    pixelsAt?: number
    hold?: 'mix' | 'drain' | 'finalize'
}
export type ToExportWorker =
    | { type: 'limits' }
    | { type: 'prepare'; start: ExportStart }
    | { type: 'view'; time: number; settings: ExportSettings }
    | { type: 'visibility'; hidden: boolean }
    | {
          type: 'start'
          start?: ExportStart
          config: Omit<ExportStart, 'assets' | 'mirror'>
          destination: ExportTarget
          faults?: ExportFaults
      }
    | { type: 'block'; block?: AudioBlock }
    | { type: 'cancel' }
    | { type: 'commit' }
export type FromExportWorker =
    | { type: 'limits'; limits?: GraphicsLimits }
    | { type: 'prepared' }
    | { type: 'view'; bitmap: ImageBitmap }
    | { type: 'block' }
    | { type: 'progress'; frames: number; bitmap?: ImageBitmap }
    | { type: 'pixels'; pixels: Uint8Array; width: number; height: number }
    | { type: 'finishing' }
    | { type: 'done'; result: unknown }
    | { type: 'failed'; error: ExportFailure }
    | { type: 'cancelled' }
    | { type: 'held'; stage: NonNullable<ExportFaults['hold']> }
