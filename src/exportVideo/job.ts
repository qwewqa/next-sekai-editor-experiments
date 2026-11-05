import type { GroupId } from '../chart/groups'
import { recordDiagnostic } from '../diagnostics'
import { detection } from '../platform/detect'
import type { Platform } from '../platform/types'
import { videoLock } from '../platform/videoOutput'
import { markVideoRunning } from '../platform/videoRunning'
import type { HideChange } from '../playerSections'
import type { SoundSource } from '../playerSounds'
import { readPreviewFilter } from '../preview/previewFilter'
import { createMirrorSender } from '../preview/worker/mirror'
import type { State } from '../state'
import { createSlideInfoLookup } from '../state/entities/slides/lookup'
import { browserEncoderProbes, createCodecProbes, type VideoFormat } from './codecs'
import { AudioFailure, exportError, VideoOutputUnavailable, withFailureDetails } from './error'
import { createExportHost } from './host'
import { mixAudio, type MixBuffers } from './mix'
import type { ExportFaults, FromExportWorker } from './protocol'
import { clipSamples } from './timing'
import {
    closeExportAssets,
    type ExportAssets,
    type ExportConfig,
    type ExportSettings,
    type ExportTarget,
} from './types'
import type { ExportWarning } from './warnings'
import { createAacCalibration } from './worker/encode'

export type JobState =
    | { phase: 'setup' | 'preparing' | 'cancelling' | 'finishing' | 'cancelled' }
    | { phase: 'exporting'; frames: number; total: number; progress: number; eta?: number }
    | {
          phase: 'ready'
          result: unknown
          warnings: ExportWarning[]
          file: File
          delivered: boolean
      }
    | { phase: 'done'; result: unknown; warnings: ExportWarning[] }
    | { phase: 'failed'; error: unknown }

/**
 * What a destination is made for: the resolved format, and whether the worker can write a
 * staged file (false after it could not open one).
 */
export type JobRoute = { format: VideoFormat; syncAccess: boolean }

export type JobDestination = {
    worker: ExportTarget
    ready?: {
        file(result: unknown): Promise<File>
        deliver(file: File, how: 'download' | 'share'): Promise<'delivered' | 'cancelled'>
        end(): Promise<void>
    }
    discard(): Promise<void>
}

const abortable = <T>(promise: Promise<T>, signal: AbortSignal, late?: (value: T) => void) =>
    new Promise<T>((resolve, reject) => {
        const abort = () => {
            reject(exportError(signal.reason))
        }
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
        void promise.then(
            (value) => {
                signal.removeEventListener('abort', abort)
                if (signal.aborted) late?.(value)
                else resolve(value)
            },
            (error: unknown) => {
                signal.removeEventListener('abort', abort)
                reject(exportError(error))
            },
        )
    })

const withoutBuffer = (result: unknown) => {
    if (!result || typeof result !== 'object' || !('buffer' in result)) return result
    const { buffer: _, ...rest } = result
    return rest
}

const soundSource = ({ store }: State): SoundSource => {
    const getInfo = createSlideInfoLookup()
    const hides = new Map<GroupId, HideChange[]>()
    for (const change of new Set([...store.grid.timeScale.values()].flatMap((set) => [...set]))) {
        let list = hides.get(change.groupId)
        if (!list) hides.set(change.groupId, (list = []))
        list.push({ beat: change.beat, hideNotes: change.hideNotes })
    }
    for (const list of hides.values()) list.sort((a, b) => a.beat - b.beat)
    return {
        notes: new Set([...store.grid.note.values()].flatMap((set) => [...set])),
        connectors: new Set([...store.grid.connector.values()].flatMap((set) => [...set])),
        getInfo: (note) => {
            const infos = store.slides.info.get(note.slideId)
            return infos && getInfo(infos).get(note)
        },
        getHideChanges: (group) => hides.get(group) ?? [],
    }
}

/** Share these caches between jobs for the life of the page. */
export const createExportServices = () => ({
    probes: createCodecProbes(
        { ...browserEncoderProbes(), aacDelay: createAacCalibration() },
        detection().engine,
        {
            diagnose: (text) => {
                recordDiagnostic('error', text)
            },
        },
    ),
})

export const createExportJob = (options: {
    snapshot: State
    settings: ExportSettings
    buffers: MixBuffers
    platform: Pick<Platform, 'onCloseRequested'>
    services: ReturnType<typeof createExportServices>
    assets(signal: AbortSignal): Promise<ExportAssets>
    destination(signal: AbortSignal, id: string, route: JobRoute): Promise<JobDestination>
    worker(): Worker
    changed(state: JobState): void
    frame?(bitmap: ImageBitmap): void
    test?: { faults?: ExportFaults; event?(message: FromExportWorker): void }
}) => {
    const snapshot = options.snapshot
    const settings = structuredClone(options.settings)
    const buffers = {
        ...options.buffers,
        bgm: options.buffers.bgm && { ...options.buffers.bgm },
        sfx: { ...options.buffers.sfx },
    }
    const id = crypto.randomUUID()
    const controller = new AbortController()
    const { signal } = controller
    let state: JobState = { phase: 'setup' }
    let running: Promise<JobState> | undefined
    let destination: JobDestination | undefined
    let stopClose: (() => void) | undefined
    let wake: WakeLockSentinel | undefined
    let active = false
    let visibleStart = performance.now()
    let visibleElapsed = 0
    let firstProgress: number | undefined
    let host: ReturnType<typeof createExportHost> | undefined
    let preparation: Promise<void> | undefined
    let lastView: Promise<unknown> | undefined
    let encoding = false
    /** The export finished and its worker was released, so views are unavailable. */
    let released = false
    let syncAccess = true
    const set = (value: JobState) => {
        state = value
        options.changed(value)
    }
    const requestWake = async () => {
        if (!active || document.hidden || !('wakeLock' in navigator) || wake) return
        try {
            const lock = await navigator.wakeLock.request('screen')
            // Visibility and ownership may change while the browser grants the lock.
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            if (active && !document.hidden && !wake) {
                wake = lock
                lock.addEventListener(
                    'release',
                    () => {
                        if (wake === lock) wake = undefined
                    },
                    { once: true },
                )
            } else await lock.release()
        } catch {
            /* A screen lock is optional. */
        }
    }
    const visibility = () => {
        host?.visibility(document.hidden)
        if (document.hidden) visibleElapsed += performance.now() - visibleStart
        else {
            visibleStart = performance.now()
            void requestWake()
        }
    }
    const resolveConfig = async () => {
        const samples = clipSamples(settings.frames, settings.frameRate)
        const codecs = await abortable(
            options.services.probes.resolve(settings, { signal }),
            signal,
        )
        if (!codecs.supported)
            throw new Error(`Encoder configuration unavailable: ${codecs.reason}`)
        return {
            settings: structuredClone(settings),
            codecs,
            samples,
            frames: settings.frames,
            frameRate: settings.frameRate,
        }
    }
    const prepare = () =>
        (preparation ??= (async () => {
            let assets: ExportAssets | undefined
            try {
                signal.throwIfAborted()
                assets = await abortable(options.assets(signal), signal, closeExportAssets)
                const mirror = createMirrorSender().diff(snapshot)
                if (!mirror) throw new Error('Export snapshot is missing')
                host = createExportHost(options.worker())
                host.visibility(document.hidden)
                const ready = host.prepare({
                    settings,
                    assets,
                    mirror,
                    filter: readPreviewFilter(settings.antialias),
                })
                assets = undefined
                await abortable(ready, signal)
            } catch (error) {
                if (assets) closeExportAssets(assets)
                host?.dispose()
                host = undefined
                // A failed preparation, for a view or an export, is tried again by the next call.
                preparation = undefined
                throw error
            }
        })())
    const run = async (): Promise<JobState> => {
        let release: (() => void) | undefined
        let clearMarker: (() => void) | undefined
        const mark = () =>
            markVideoRunning(id, {
                resolution: settings.height,
                renderScale: settings.renderScale,
            })
        active = true
        stopClose = options.platform.onCloseRequested(
            () => !active && !(state.phase === 'ready' && !state.delivered),
        )
        document.addEventListener('visibilitychange', visibility)
        void requestWake()
        /** One export into `target`, under the job lock unless staging holds it. */
        const encode = async (target: JobDestination, config: ExportConfig) => {
            if (!host) throw new Error('Export worker is unavailable')
            const runner = host
            // Staging already holds the job lock, through Ready and retention.
            if (target.worker.kind !== 'staged') {
                let acquired!: () => void
                const ready = new Promise<void>((resolve) => {
                    acquired = resolve
                })
                const held = new Promise<void>((resolve) => {
                    release = resolve
                })
                const lock = navigator.locks.request(videoLock(id), { signal }, async () => {
                    acquired()
                    await held
                })
                await abortable(Promise.race([ready, lock]), signal)
            }
            clearMarker = mark()
            const audio = mixAudio(soundSource(snapshot), snapshot.bpms, buffers, settings, signal)
            set({ phase: 'exporting', frames: 0, total: settings.frames, progress: 0 })
            signal.throwIfAborted()
            encoding = true
            return await runner.run(config, target.worker, {
                signal,
                block: async () => {
                    let next
                    try {
                        next = await audio.next()
                    } catch (error) {
                        throw signal.aborted ? error : new AudioFailure(error)
                    }
                    return next.done ? undefined : next.value
                },
                faults: options.test?.faults,
                event: (event) => {
                    options.test?.event?.(event)
                    if (event.type === 'finishing') {
                        if (!signal.aborted) set({ phase: 'finishing' })
                    } else if (event.type === 'progress') {
                        if (event.bitmap) {
                            if (!signal.aborted && options.frame) options.frame(event.bitmap)
                            else event.bitmap.close()
                        }
                        if (signal.aborted) return
                        const elapsed =
                            visibleElapsed +
                            (document.hidden ? 0 : performance.now() - visibleStart)
                        firstProgress ??= elapsed
                        const eta =
                            elapsed - firstProgress >= 2000
                                ? (((elapsed - firstProgress) / Math.max(1, event.frames - 1)) *
                                      (settings.frames - event.frames)) /
                                  1000
                                : undefined
                        set({
                            phase: 'exporting',
                            frames: event.frames,
                            total: settings.frames,
                            progress: event.frames / settings.frames,
                            eta,
                        })
                    }
                },
            })
        }
        set({ phase: 'preparing' })
        // Failures before the one reported, for Error Details.
        const earlier: unknown[] = []
        try {
            if (
                !Number.isFinite(settings.in) ||
                settings.in < 0 ||
                ![30, 60].includes(settings.frameRate) ||
                ![1, 1.5, 2].includes(settings.renderScale) ||
                ![settings.width, settings.height].every((n) => Number.isInteger(n) && n > 0)
            )
                throw new Error('Invalid export settings')
            clipSamples(settings.frames, settings.frameRate)
            signal.throwIfAborted()
            // Track interrupted preparation under its own hold. The destination takes this lock later.
            const config = await navigator.locks.request(videoLock(id), { signal }, async () => {
                const clear = mark()
                try {
                    await prepare()
                    const config = await resolveConfig()
                    // The export waits for the last view to be drawn; a view that failed does
                    // not stop it.
                    await abortable(
                        Promise.resolve(lastView).catch(() => undefined),
                        signal,
                    )
                    return config
                } finally {
                    clear()
                }
            })
            if (!host) throw new Error('Export worker is unavailable')
            signal.throwIfAborted()
            const route = (): JobRoute => ({ format: config.codecs.format, syncAccess })
            // A destination that arrives after Cancel is discarded.
            const destinationOf = (made: Promise<JobDestination>) =>
                abortable(made, signal, (late) => {
                    void late.discard().catch(() => undefined)
                })
            let target = (destination = await destinationOf(
                options.destination(signal, id, route()),
            ))
            let result: Awaited<ReturnType<typeof encode>>
            for (;;) {
                signal.throwIfAborted()
                try {
                    result = await encode(target, config)
                    break
                } catch (error) {
                    if (signal.aborted) throw error
                    // A worker that cannot open a staged file encoded nothing; it writes to
                    // memory instead, with the same worker.
                    if (
                        error instanceof VideoOutputUnavailable &&
                        error.reason === 'staging' &&
                        target.worker.kind === 'staged' &&
                        syncAccess
                    ) {
                        syncAccess = false
                        encoding = false
                        clearMarker?.()
                        clearMarker = undefined
                        await target.discard().catch((cleanup: unknown) => earlier.push(cleanup))
                        destination = undefined
                        target = destination = await destinationOf(
                            options.destination(signal, id, route()),
                        )
                        continue
                    }
                    throw error
                }
            }
            // The worker is done. Ready keeps the file, not the in-memory route's buffer.
            released = true
            host.dispose()
            host = undefined
            const { warnings } = result
            if (target.ready) {
                const file = await target.ready.file(result.result)
                set({
                    phase: 'ready',
                    result: withoutBuffer(result.result),
                    warnings,
                    file,
                    delivered: false,
                })
            } else set({ phase: 'done', result: result.result, warnings })
        } catch (error) {
            const cancelled = signal.aborted
            controller.abort(error)
            host?.dispose()
            host = undefined
            let failure = cancelled ? error : withFailureDetails(error, earlier)
            clearMarker?.()
            try {
                await destination?.discard()
            } catch (cleanupError) {
                // A canceled export reports only a failed cleanup; a failed one keeps its cause.
                failure = cancelled ? cleanupError : withFailureDetails(failure, [cleanupError])
            }
            set(
                cancelled && failure === error
                    ? { phase: 'cancelled' }
                    : { phase: 'failed', error: failure },
            )
        } finally {
            clearMarker?.()
            release?.()
            active = false
            document.removeEventListener('visibilitychange', visibility)
            await wake?.release().catch(() => undefined)
            wake = undefined
            if (state.phase !== 'ready') {
                stopClose()
                stopClose = undefined
            }
        }
        return state
    }
    return {
        id,
        get state() {
            return state
        },
        /** A superseded queued view resolves without a bitmap. The caller closes returned bitmaps. */
        preview(
            time: number,
            viewSettings: Partial<Pick<ExportSettings, 'width' | 'height'>> = {},
        ) {
            if (active || released || signal.aborted)
                return Promise.reject(new Error('Export view is unavailable'))
            const pending = (async () => {
                await prepare()
                if (!host) throw new Error('Export worker is unavailable')
                return host.view(time, { ...settings, ...viewSettings })
            })()
            lastView = pending
            return pending
        },
        configure(value: ExportSettings) {
            if (active || running || signal.aborted)
                throw new Error('Export settings are already in use')
            Object.assign(settings, structuredClone(value))
        },
        start: () => (running ??= run()),
        cancel() {
            if (
                state.phase === 'finishing' ||
                state.phase === 'ready' ||
                state.phase === 'done' ||
                state.phase === 'failed' ||
                state.phase === 'cancelled'
            )
                return false
            controller.abort()
            if (!encoding) {
                host?.dispose()
                host = undefined
            }
            set({ phase: running ? 'cancelling' : 'cancelled' })
            return true
        },
        async deliver(how: 'download' | 'share') {
            if (state.phase !== 'ready' || !destination?.ready)
                throw new Error('Video is not ready')
            const current = state
            const result = await destination.ready.deliver(current.file, how)
            if (result === 'delivered' && state === current) set({ ...current, delivered: true })
            return result
        },
        /** The dialog confirms discarding an undelivered file before calling this. */
        async endReady() {
            if (state.phase !== 'ready') return
            const { result, warnings } = state
            try {
                await destination?.ready?.end()
            } finally {
                stopClose?.()
                stopClose = undefined
                set({ phase: 'done', result, warnings })
            }
        },
        async dispose() {
            if (active && state.phase !== 'finishing') {
                controller.abort()
                set({ phase: 'cancelling' })
            }
            await running
            controller.abort()
            await preparation?.catch(() => undefined)
            host?.dispose()
            host = undefined
            if (state.phase === 'ready') await this.endReady()
        },
    }
}
