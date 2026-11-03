import type { ExportFailure } from './error'
import type { GraphicsLimits } from './graphics'
import type { AudioBlock } from './timing'
import type { ExportConfig, ExportScene, ExportSettings, ExportTarget } from './types'
import type { ExportWarning } from './warnings'

export type ExportFaults = {
    failWrite?: boolean
    /** Loses the context before this frame's capture; at the frame count, after the last. */
    loseContextAt?: number
    pixelsAt?: number
    hold?: 'mix' | 'drain' | 'finalize'
    /** Refuses one operation on a picked file in the worker: reading, opening, writing or closing. */
    refuse?: 'read' | 'open' | 'write' | 'close'
    /** The worker has no `createSyncAccessHandle`, as in browsers without it. */
    noSyncAccess?: boolean
}
export type ToExportWorker =
    | { type: 'limits' }
    | { type: 'prepare'; scene: ExportScene }
    | { type: 'view'; time: number; settings: ExportSettings }
    | { type: 'visibility'; hidden: boolean }
    | {
          type: 'start'
          config: ExportConfig
          destination: ExportTarget
          faults?: ExportFaults
      }
    | { type: 'block'; block?: AudioBlock }
    | { type: 'cancel' }
    | { type: 'commit' }
export type FromExportWorker =
    | { type: 'limits'; limits?: GraphicsLimits; memoryRoute?: boolean }
    | { type: 'prepared' }
    | { type: 'view'; bitmap: ImageBitmap }
    | { type: 'block' }
    | { type: 'progress'; frames: number; bitmap?: ImageBitmap }
    | { type: 'pixels'; pixels: Uint8Array; width: number; height: number }
    | { type: 'finishing' }
    | { type: 'done'; result: unknown; warnings: ExportWarning[] }
    | { type: 'failed'; error: ExportFailure }
    | { type: 'cancelled' }
    | { type: 'held'; stage: NonNullable<ExportFaults['hold']> }
