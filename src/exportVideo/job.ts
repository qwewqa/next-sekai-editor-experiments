import type { GroupId } from '../chart/groups'
import { detection } from '../platform/detect'
import type { Platform } from '../platform/types'
import { videoLock } from '../platform/videoOutput'
import { markVideoRunning } from '../platform/videoRunning'
import type { HideChange } from '../playerSections'
import type { SoundSource } from '../playerSounds'
import { createMirrorSender } from '../preview/worker/mirror'
import type { State } from '../state'
import { createSlideInfoLookup } from '../state/entities/slides/lookup'
import { browserEncoderProbes, createCodecProbes } from './codecs'
import { exportError } from './error'
import { createExportHost } from './host'
import { mixAudio, type MixBuffers } from './mix'
import type { ExportFaults, FromExportWorker } from './protocol'
import { clipSamples } from './timing'
import {
    closeExportAssets,
    type ExportAssets,
    type ExportSettings,
    type ExportTarget,
} from './types'
import { createAacCalibration } from './worker/encode'

export type JobState =
    | { phase: 'setup' | 'preparing' | 'cancelling' | 'finishing' | 'cancelled' }
    | { phase: 'exporting'; frames: number; total: number; progress: number; eta?: number }
    | { phase: 'ready'; result: unknown; file: File; delivered: boolean }
    | { phase: 'done'; result: unknown }
    | { phase: 'failed'; error: unknown }

export type JobDestination = {
    worker: ExportTarget
    /** Staging already holds the job lock, through Ready and retention. */
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
    probes: createCodecProbes(browserEncoderProbes(), detection().engine),
    calibrate: createAacCalibration(),
})

export const createExportJob = (options: {
    snapshot: State
    settings: ExportSettings
    buffers: MixBuffers
    platform: Pick<Platform, 'onCloseRequested'>
    services: ReturnType<typeof createExportServices>
    assets(signal: AbortSignal): Promise<ExportAssets>
    destination(signal: AbortSignal, id: string): Promise<JobDestination>
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
        const codecs = await abortable(options.services.probes.resolve(settings), signal)
        if (!codecs.supported)
            throw new Error(`Encoder configuration unavailable: ${codecs.reason}`)
        const aacDelay =
            codecs.audio?.codec === 'mp4a.40.2'
                ? await abortable(options.services.calibrate(codecs.audio), signal)
                : undefined
        return {
            settings: structuredClone(settings),
            codecs,
            aacDelay,
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
                const ready = host.prepare({ settings, assets, mirror })
                assets = undefined
                await abortable(ready, signal)
            } catch (error) {
                if (assets) closeExportAssets(assets)
                host?.dispose()
                host = undefined
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
        set({ phase: 'preparing' })
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
                    await abortable(Promise.resolve(lastView), signal)
                    return config
                } finally {
                    clear()
                }
            })
            if (!host) throw new Error('Export worker is unavailable')
            signal.throwIfAborted()
            destination = await options.destination(signal, id)
            signal.throwIfAborted()
            if (destination.worker.kind !== 'staged') {
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
            const resultPromise = host.run(config, destination.worker, {
                signal,
                block: async () => {
                    const next = await audio.next()
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
            const result = await resultPromise
            if (destination.ready)
                set({
                    phase: 'ready',
                    result,
                    file: await destination.ready.file(result),
                    delivered: false,
                })
            else set({ phase: 'done', result })
        } catch (error) {
            const cancelled = signal.aborted
            controller.abort(error)
            host?.dispose()
            host = undefined
            let failure = error
            clearMarker?.()
            try {
                await destination?.discard()
            } catch (cleanupError) {
                failure = cleanupError
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
            if (active || signal.aborted)
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
            const result = state.result
            try {
                await destination?.ready?.end()
            } finally {
                stopClose?.()
                stopClose = undefined
                set({ phase: 'done', result })
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
