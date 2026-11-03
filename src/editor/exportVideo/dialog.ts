// The Export Video dialog's state: the clip, the settings, the job and its outcome. The dialog
// renders this; the job owns every resource of an export (src/exportVideo/job.ts).

import { computed, reactive, ref, shallowRef, watch } from 'vue'
import { bump, busy, record } from '../../analytics/tally'
import {
    createCodecAvailability,
    outputSize,
    type CodecSettings,
    type CodecSupport,
} from '../../exportVideo/codecs'
import {
    AUDIO_BITRATES,
    estimateBytes,
    presetBitrate,
    qualityOf,
    RESOLUTIONS,
    type Quality,
    type Resolution,
} from '../../exportVideo/estimate'
import { fitsGraphicsLimits, type GraphicsLimits } from '../../exportVideo/graphics'
import {
    createExportJob,
    createExportServices,
    type JobDestination,
    type JobRoute,
    type JobState,
} from '../../exportVideo/job'
import type { FromExportWorker } from '../../exportVideo/protocol'
import type { ExportSettings } from '../../exportVideo/types'
import type { ExportWarning } from '../../exportVideo/warnings'
import { bgmEndOf } from '../../levelData/statistics'
import { isNearlyFull } from '../../local/nearlyFull'
import { platform } from '../../platform'
import { loadedSfx, sfxSettled } from '../../player'
import { previewAspectRatios } from '../../preview/options'
import { settings } from '../../settings'
import type { ExportVideoChoices } from '../../settings/exportVideo'
import type { State } from '../../state'
import type { Bgm } from '../../state/bgm'
import type { Entity } from '../../state/entities'
import { beatToTime } from '../../state/integrals/bpms'
import { copyExportAssets } from './assets'
import {
    clampRange,
    clampToSpan,
    clipLength,
    frameCount,
    keepInSpan,
    lastObjectBeat,
    openingRange,
    selectionRange,
    selectionSpan,
    setEnd,
    stripEndOf,
    toFrame,
    wholeChartEnd,
    wholeRange,
    zoomSpan,
    type ClipRange,
    type RangeKind,
} from './clipRange'
import { memoryRouteTaken } from './destination'
import type { DestinationRequest, ExportVideoEnv } from './env'
import { describeVideoFailure, type VideoFailure } from './failure'
import { exportMessages } from './messages'
import {
    finishedVideoExport,
    openingVideoChoices,
    rememberedVideoChoices,
    resetVideoChoices,
} from './recovery'
import { videoReport, type VideoReportEnd, type VideoReportSettings } from './report'
import { videoFileName } from './videoName'

/** One per page: the probe and AAC calibration caches outlive each dialog. */
let services: ReturnType<typeof createExportServices> | undefined

/** The range each chain used last in this page, by its kind. */
const rangeMemory = new Map<string, { kind: RangeKind; range: ClipRange }>()

export type DialogInput = {
    snapshot: State
    source: 'live' | 'peek'
    /** The chart's chain; none for a peeked session, so its range is not remembered. */
    chain?: string
    /** The editor's playback cursor, where the playhead starts. */
    cursor: number
    stem: string
    look: {
        aspect: number
        noteSpeed: number
        showEffects: boolean
        showCombo: boolean
        backdrop: ExportSettings['backdrop']
    }
    bgm: Bgm
    /** Why BGM is unavailable, if it is. */
    bgmMissing?: 'none' | 'notLoaded'
    selection: readonly Entity[]
    env: ExportVideoEnv
}

export type Phase =
    'setup' | 'preparing' | 'exporting' | 'cancelling' | 'finishing' | 'ready' | 'done' | 'failed'

/**
 * What an attempt asked for, which its file's warnings compare with, and its estimated size, which
 * Ready's memory warning compares with.
 */
export type Asked = Pick<ExportSettings, 'width' | 'height' | 'bgm' | 'sfx'> & { bytes: number }

/**
 * An export's end that the footer shows until the next change. A file keeps its warnings, what
 * its attempt asked for, and whether the page was hidden during it.
 */
export type Outcome =
    | {
          kind: 'done'
          name: string
          size?: number
          warnings: ExportWarning[]
          asked: Asked
          hidden: boolean
      }
    | {
          kind: 'ready'
          size: number
          delivered: boolean
          shareable: boolean
          warnings: ExportWarning[]
          asked: Asked
          hidden: boolean
      }
    | { kind: 'failed'; failure: VideoFailure }

export type Unavailable = 'browser' | 'device'

const formFromSettings = (look: DialogInput['look']) => {
    const choices = openingVideoChoices()
    return {
        aspect: previewAspectRatios.find(([, value]) => value === look.aspect)?.[1] ?? 16 / 9,
        resolution: choices.resolution,
        frameRate: choices.frameRate,
        quality: choices.quality as Quality | 'custom',
        customBitrate: 8,
        bgm: true,
        sfx: true,
        format: choices.format,
        antialias: choices.antialias,
        renderScale: choices.renderScale,
        noteSpeed: look.noteSpeed,
        showEffects: look.showEffects,
        showCombo: look.showCombo,
        fadeIn: 0,
        fadeOut: 0,
        bgmVolume: settings.playBgmVolume,
        sfxVolume: settings.playSfxVolume,
        audioBitrate: choices.audioBitrate,
    }
}

export const createExportDialog = (input: DialogInput) => {
    const shared = (services ??= createExportServices())
    const probes = shared.probes
    const fps = () => form.frameRate
    const form = reactive(formFromSettings(input.look))
    if (input.bgmMissing) form.bgm = false

    // --- The clip.
    const bgmEnd = bgmEndOf(input.bgm)
    const lastBeat = lastObjectBeat(input.snapshot)
    const wholeEnd = wholeChartEnd(
        lastBeat === undefined ? undefined : beatToTime(input.snapshot.bpms, lastBeat),
    )
    const stripEnd = stripEndOf(wholeEnd, bgmEnd)
    const initial = openingRange(
        input.chain === undefined ? undefined : rangeMemory.get(input.chain),
        wholeEnd,
        bgmEnd,
        fps(),
    )
    const rangeKind = ref<RangeKind>(initial.kind)
    const range = ref<ClipRange>(initial.range)
    const playhead = ref(Math.min(stripEnd, Math.max(0, toFrame(input.cursor, fps()))))
    const span = computed(() => selectionSpan(input.selection, input.snapshot.bpms))
    const hours = stripEnd >= 3600
    const remember = () => {
        if (input.chain !== undefined)
            rangeMemory.set(input.chain, { kind: rangeKind.value, range: range.value })
    }

    // --- The span the strip shows: the whole strip, or the range's under Zoom to Range. The
    // playhead stays inside it.
    const zoomed = ref(false)
    const stripSpan = computed((): [number, number] =>
        zoomed.value ? zoomSpan(range.value, stripEnd) : [0, stripEnd],
    )
    /** Moves the playhead. Playback stops first, or its next frame would put its own time back. */
    const movePlayhead = (time: number) => {
        stopPlayback()
        playhead.value = time
    }
    /** Moves the playhead to the frame nearest a time, inside the span the strip draws. */
    const seek = (time: number, within: readonly [number, number] = stripSpan.value) => {
        movePlayhead(clampToSpan(time, within, fps()))
    }
    /** A playhead outside the strip moves to the range's nearer end. */
    const keepPlayhead = (time = playhead.value) => {
        const next = keepInSpan(time, stripSpan.value, range.value)
        if (next !== playhead.value) movePlayhead(next)
    }
    const setZoomed = (on: boolean) => {
        zoomed.value = on
        const [from, to] = stripSpan.value
        if (playhead.value < from || playhead.value > to) movePlayhead(range.value.in)
    }

    const setRange = (next: ClipRange, kind: RangeKind = 'custom') => {
        range.value = clampRange(next, stripEnd, fps())
        keepPlayhead()
        rangeKind.value = kind
        remember()
        changed()
    }
    const setClipEnd = (end: 'in' | 'out', time: number) => {
        range.value = setEnd(range.value, end, time, stripEnd, fps())
        keepPlayhead()
        rangeKind.value = 'custom'
        remember()
        changed()
    }
    const useWhole = () => {
        setRange(wholeRange(wholeEnd, fps()), 'whole')
    }
    const useBgm = () => {
        if (bgmEnd === undefined) return
        setRange(wholeRange(bgmEnd, fps()), 'bgm')
    }
    const useSelection = () => {
        if (!span.value) return
        setRange(selectionRange(span.value, form.noteSpeed, stripEnd, fps()), 'selection')
    }
    const frames = computed(() => frameCount(range.value, fps()))
    const length = computed(() => clipLength(range.value, fps()))

    // --- The output and what this browser and device can make of it.
    const size = computed(() => outputSize(form.resolution, form.aspect))
    const videoBitrate = computed(() =>
        form.quality === 'custom'
            ? Math.round(form.customBitrate * 1e6)
            : presetBitrate(form.quality, form.resolution, form.frameRate, size.value.width),
    )
    const setBitrate = (mbps: number) => {
        form.customBitrate = mbps
        form.quality = qualityOf(mbps * 1e6, form.resolution, form.frameRate, size.value.width)
    }
    const hasAudio = computed(() => form.bgm || form.sfx)
    const codecSettings = computed((): CodecSettings => ({
        format: form.format,
        width: size.value.width,
        height: size.value.height,
        frameRate: form.frameRate,
        videoBitrate: videoBitrate.value,
        audioBitrate: form.audioBitrate,
        bgm: form.bgm,
        sfx: form.sfx,
    }))
    const availability = createCodecAvailability(probes)
    const support = shallowRef<{
        pending: boolean
        current?: CodecSupport
        choices: Record<string, CodecSupport>
    }>({ pending: true, choices: {} })
    watch(
        codecSettings,
        async (value) => {
            const choices: Record<string, Partial<CodecSettings>> = {}
            for (const resolution of RESOLUTIONS) {
                const { width, height } = outputSize(resolution, form.aspect)
                choices[`resolution:${resolution}`] = {
                    width,
                    height,
                    videoBitrate:
                        form.quality === 'custom'
                            ? value.videoBitrate
                            : presetBitrate(form.quality, resolution, form.frameRate, width),
                }
            }
            for (const frameRate of [30, 60] as const)
                choices[`frameRate:${frameRate}`] = {
                    frameRate,
                    videoBitrate:
                        form.quality === 'custom'
                            ? value.videoBitrate
                            : presetBitrate(form.quality, form.resolution, frameRate, value.width),
                }
            for (const format of ['automatic', 'mp4', 'webm'] as const)
                choices[`format:${format}`] = { format }
            for (const audioBitrate of AUDIO_BITRATES)
                choices[`audioBitrate:${audioBitrate}`] = { audioBitrate }
            // Whether the video works without the selected sound.
            if (value.bgm || value.sfx) choices['sound:off'] = { bgm: false, sfx: false }
            support.value = { ...support.value, pending: true }
            await availability.update(value, choices, (state) => {
                support.value = state
            })
        },
        { immediate: true, deep: true },
    )
    // Undefined until the worker replies; null where it has no WebGL2 or fails. Unknown limits
    // do not stop an export; a size that cannot be drawn fails it at the first frame.
    const limits = shallowRef<GraphicsLimits | null>()
    /**
     * Whether exports take the in-memory route, as an earlier export in this page found or the
     * limits worker reports; undefined while unknown.
     */
    const memoryRoute = ref(input.env.picker ? false : memoryRouteTaken() || undefined)
    const limitsWorker = input.env.worker()
    limitsWorker.onmessage = ({ data }: MessageEvent<FromExportWorker>) => {
        if (data.type !== 'limits') return
        limits.value = data.limits ?? null
        memoryRoute.value ??= data.memoryRoute
        limitsWorker.terminate()
    }
    limitsWorker.onerror = () => {
        limits.value = null
        limitsWorker.terminate()
    }
    limitsWorker.postMessage({ type: 'limits' })
    /** Known not to fit; Export still waits for the limits. */
    const tooLarge = (resolution: Resolution, scale: number) =>
        !!limits.value &&
        !fitsGraphicsLimits(
            outputSize(resolution, form.aspect),
            scale,
            form.antialias,
            limits.value,
        )
    const browserOk = (key: string) => {
        const choice = support.value.choices[key]
        return !choice || choice.supported
    }
    const unavailable = computed(() => {
        const out: Record<string, Unavailable | undefined> = {}
        for (const resolution of RESOLUTIONS)
            out[`resolution:${resolution}`] = tooLarge(resolution, form.renderScale)
                ? 'device'
                : browserOk(`resolution:${resolution}`)
                  ? undefined
                  : 'browser'
        for (const scale of [1, 1.5, 2] as const)
            out[`renderScale:${scale}`] = tooLarge(form.resolution, scale) ? 'device' : undefined
        for (const frameRate of [30, 60])
            out[`frameRate:${frameRate}`] = browserOk(`frameRate:${frameRate}`)
                ? undefined
                : 'browser'
        for (const format of ['automatic', 'mp4', 'webm'])
            out[`format:${format}`] = browserOk(`format:${format}`) ? undefined : 'browser'
        for (const audioBitrate of AUDIO_BITRATES)
            out[`audioBitrate:${audioBitrate}`] =
                !hasAudio.value || browserOk(`audioBitrate:${audioBitrate}`) ? undefined : 'browser'
        return out
    })
    const resolved = computed(() => {
        const current = support.value.current
        return current?.supported ? current : undefined
    })
    /** The format the file gets: Automatic's choice once known. */
    const format = computed(
        () => resolved.value?.format ?? (form.format === 'webm' ? 'webm' : 'mp4'),
    )
    const ready = computed(
        () =>
            !support.value.pending &&
            !!resolved.value &&
            limits.value !== undefined &&
            !tooLarge(form.resolution, form.renderScale) &&
            frames.value > 0 &&
            // The sound effects an export mixes are taken as it starts.
            (!form.sfx || sfxSettled.value),
    )

    // --- Estimates.
    const bytes = computed(() =>
        estimateBytes(length.value, videoBitrate.value, hasAudio.value ? form.audioBitrate : 0),
    )

    // --- Fades: together at most the clip, so the fields show what the export uses. A shorter
    // clip shortens Fade Out first, then Fade In, as the mix would.
    const tenths = (value: number) => Math.max(0, Math.floor(value * 10 + 1e-6) / 10)
    const fadeLimits = computed(() => ({
        fadeIn: tenths(length.value - form.fadeOut),
        fadeOut: tenths(length.value - form.fadeIn),
    }))
    watch(length, (value) => {
        if (form.fadeIn > value) form.fadeIn = tenths(value)
        if (form.fadeIn + form.fadeOut > value) form.fadeOut = tenths(value - form.fadeIn)
    })

    // --- A staged file counts toward browser storage: past the line where cleanup starts, the
    // dialog warns before the export, and still allows it.
    const storageNearlyFull = ref(false)
    // Insecure origins have no storage manager.
    if (!input.env.picker && 'storage' in navigator)
        watch(
            bytes,
            async (estimated) => {
                const { usage, quota } = await navigator.storage
                    .estimate()
                    .catch((): StorageEstimate => ({}))
                storageNearlyFull.value =
                    usage !== undefined && isNearlyFull({ usage: usage + estimated, quota })
            },
            { immediate: true },
        )

    // --- Settings the export uses.
    const exportSettings = (): ExportSettings => ({
        in: range.value.in,
        frames: frames.value,
        frameRate: form.frameRate,
        width: size.value.width,
        height: size.value.height,
        format: resolved.value?.format ?? form.format,
        videoBitrate: videoBitrate.value,
        audioBitrate: form.audioBitrate,
        bgm: form.bgm,
        sfx: form.sfx,
        bgmVolume: form.bgmVolume,
        sfxVolume: form.sfxVolume,
        fadeIn: Math.min(form.fadeIn, length.value),
        fadeOut: Math.min(form.fadeOut, Math.max(0, length.value - form.fadeIn)),
        renderScale: form.renderScale,
        antialias: form.antialias,
        noteSpeed: form.noteSpeed,
        showEffects: form.showEffects,
        showCombo: form.showCombo,
        backdrop: input.look.backdrop,
    })

    const restoreDefaults = () => {
        const cleared = resetVideoChoices()
        Object.assign(form, formFromSettings(input.look), { bgm: !input.bgmMissing })
        return cleared
    }

    // --- The job, its frames and its outcome.
    const phase = ref<Phase>('setup')
    const outcome = shallowRef<Outcome>()
    // What the running attempt asked for, kept with its outcome.
    let asked: Asked = { width: 0, height: 0, bgm: false, sfx: false, bytes: 0 }
    const progress = ref<{ fraction: number; eta?: number }>({ fraction: 0 })
    let frameSink: ((bitmap: ImageBitmap) => void) | undefined
    const onFrame = (draw: (bitmap: ImageBitmap) => void) => {
        frameSink = draw
    }
    // The sound effects each job was made with: an export takes those loaded when it starts.
    const jobSfx = new WeakMap<object, ReturnType<typeof loadedSfx>>()
    const sameSfx = (a: ReturnType<typeof loadedSfx>, b: ReturnType<typeof loadedSfx> = {}) => {
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof typeof a>
        return [...keys].every((key) => a[key] === b[key])
    }
    const newJob = () => {
        const sfx = loadedSfx()
        const created: ReturnType<typeof createExportJob> = createExportJob({
            snapshot: input.snapshot,
            settings: exportSettings(),
            buffers: {
                bgm:
                    input.bgm.buffer && !input.bgmMissing
                        ? { buffer: input.bgm.buffer, offset: input.bgm.offset }
                        : undefined,
                sfx,
            },
            platform,
            services: shared,
            assets: copyExportAssets,
            destination: (signal, id, route) => destinationFor(signal, id, route),
            ...(input.env.fallback
                ? {
                      fallback: (signal: AbortSignal, id: string, route: JobRoute) =>
                          destinationFor(signal, id, route, true),
                  }
                : {}),
            worker: () => input.env.worker(),
            changed: (state) => {
                if (created === current) void onState(state)
            },
            frame: (bitmap) => {
                if (frameSink) frameSink(bitmap)
                else bitmap.close()
            },
            test: input.env.faults ? { faults: input.env.faults } : undefined,
        })
        jobSfx.set(created, sfx)
        return created
    }
    let job = newJob()
    // The job whose export is running or whose result is shown.
    let current: ReturnType<typeof newJob> | undefined
    const viewJob = shallowRef(job)

    // The press's destination, kept for the file's name and size at the end.
    let picked: { name: string; handle?: FileSystemFileHandle; staged?: boolean } | undefined
    const destinationFor = async (
        signal: AbortSignal,
        id: string,
        route: JobRoute,
        fallback = false,
    ): Promise<JobDestination> => {
        // The file is named for the format the job resolved; the fallback keeps the name the
        // picker gave the file.
        if (attempt.settings) attempt.settings.format = route.format
        const name = (fallback ? picked?.name : undefined) ?? fileName(route.format)
        const picker = input.env.picker && !fallback
        attempt.stage = picker ? 'pick' : 'prepare'
        const opened = performance.now()
        const request: DestinationRequest = {
            signal,
            id,
            name,
            format: route.format,
            syncAccess: route.syncAccess,
            dismissed: () => {
                attempt.target = 'none'
                current?.cancel()
            },
        }
        let destination: JobDestination
        try {
            destination = await (fallback && input.env.fallback
                ? input.env.fallback(request)
                : input.env.destination(request))
        } finally {
            if (picker) attempt.pickMs = performance.now() - opened
        }
        const worker = destination.worker
        picked =
            worker.kind === 'picked'
                ? { name: worker.pick.handle.name, handle: worker.pick.handle }
                : { name, staged: worker.kind === 'staged' }
        attempt.target =
            worker.kind === 'picked' ? 'picker' : worker.kind === 'memory' ? 'memory' : 'none'
        if (worker.kind === 'memory') memoryRoute.value = true
        attempt.stage = 'prepare'
        return destination
    }
    const fileName = (as = format.value) =>
        videoFileName(input.stem, rangeKind.value, range.value, as)

    // --- One usage event per attempt, after its delivery is known.
    const attempt: {
        settings?: VideoReportSettings
        remembered?: ExportVideoChoices
        stage: NonNullable<VideoReportEnd['stage']>
        target: VideoReportEnd['target']
        hidden: boolean
        pressed?: number
        /** Time in the picker and in the waits and Ready press before it. `took` leaves it out. */
        pickMs?: number
        lengthSeconds: number
        renderStart?: number
        renderMs?: number
        workMs?: number
        size?: number
    } = { stage: 'prepare', target: 'none', hidden: false, lengthSeconds: 0 }
    const report = (end: Omit<VideoReportEnd, 'target' | 'hidden' | 'lengthSeconds'>) => {
        if (!attempt.settings) return
        record(
            'exportVideo',
            videoReport(attempt.settings, {
                tookMs: attempt.workMs,
                renderingMs: attempt.renderMs,
                ...end,
                target: attempt.target,
                hidden: attempt.hidden,
                lengthSeconds: attempt.lengthSeconds,
            }),
        )
        attempt.settings = undefined
    }
    const onHidden = () => {
        if (document.hidden) attempt.hidden = true
    }

    let returnTo = 0
    const onState = async (state: JobState) => {
        switch (state.phase) {
            case 'preparing':
            case 'cancelling':
            case 'finishing':
                phase.value = state.phase
                if (state.phase === 'finishing') {
                    attempt.stage = 'finish'
                    attempt.renderMs =
                        attempt.renderStart === undefined
                            ? undefined
                            : performance.now() - attempt.renderStart
                }
                return
            case 'exporting':
                attempt.stage = 'render'
                attempt.renderStart ??= performance.now()
                phase.value = 'exporting'
                progress.value = { fraction: state.progress, eta: state.eta }
                playhead.value = range.value.in + state.frames / fps()
                return
            case 'setup':
                return
            case 'ready':
            case 'done':
            case 'failed':
            case 'cancelled':
                break
        }
        // An attempt ends once. A delivery reports Ready again, and `deliver` handles it.
        if (!busyPhase.value) return
        const ended = current
        const failure =
            state.phase === 'failed'
                ? await describeVideoFailure(state.error, fileName(), asked, picked?.handle)
                : undefined
        if (current !== ended) return
        // The attempt ended.
        busy(false)
        document.removeEventListener('visibilitychange', onHidden)
        attempt.workMs =
            attempt.pressed === undefined
                ? undefined
                : performance.now() - attempt.pressed - (attempt.pickMs ?? 0)
        // Zoom to Range may have been pressed during the export.
        keepPlayhead(returnTo)
        if (state.phase === 'cancelled') {
            report({ outcome: 'cancelled', stage: attempt.stage })
            outcome.value = undefined
            phase.value = 'setup'
            current = undefined
            retire(ended)
        } else if (failure) {
            report({ outcome: 'failed', stage: attempt.stage, reason: failure.reason })
            outcome.value = { kind: 'failed', failure }
            phase.value = 'failed'
            current = undefined
            retire(ended)
        } else {
            succeeded()
            if (state.phase === 'ready') {
                outcome.value = {
                    kind: 'ready',
                    size: state.file.size,
                    warnings: state.warnings,
                    asked,
                    hidden: attempt.hidden,
                    delivered: false,
                    // Share Video is offered for a coarse pointer, as Share Image is.
                    shareable:
                        !!picked?.staged &&
                        matchMedia('(pointer: coarse)').matches &&
                        (platform.videoOutput?.canShare(state.file) ?? false),
                }
                phase.value = 'ready'
            } else if (state.phase === 'done') void finishDone(state.result, state.warnings)
        }
        // Views need a job that is still in setup.
        job = newJob()
        viewJob.value = job
    }
    /** Releases an ended job's worker once its run has settled. */
    const retire = (ended: ReturnType<typeof newJob> | undefined) => {
        if (ended) void ended.start().then(() => ended.dispose())
    }
    const succeeded = () => {
        if (attempt.remembered) finishedVideoExport(attempt.remembered)
    }
    const finishDone = async (result: unknown, warnings: ExportWarning[]) => {
        const name = picked?.name ?? fileName()
        let size =
            typeof result === 'object' && result && 'size' in result
                ? Number(result.size)
                : undefined
        try {
            size ??= (await picked?.handle?.getFile())?.size
        } catch {
            // The size is left out when the file cannot be read.
        }
        attempt.size = size
        report({
            outcome: 'done',
            sizeBytes: size,
            tookMs: attempt.workMs,
            renderingMs: attempt.renderMs,
        })
        outcome.value = { kind: 'done', name, size, warnings, asked, hidden: attempt.hidden }
        phase.value = 'done'
        const ended = current
        current = undefined
        retire(ended)
    }

    const reportSettings = (): VideoReportSettings => ({
        format: format.value,
        support: support.value.choices['format:mp4']?.supported ? 'full' : 'webmOnly',
        resolution: form.resolution,
        frameRate: form.frameRate,
        aspect: (previewAspectRatios.find(([, value]) => value === form.aspect)?.[0] ??
            '16:9') as VideoReportSettings['aspect'],
        quality: form.quality,
        renderScale: form.renderScale,
        antialias: form.antialias,
        audio: form.bgm && form.sfx ? 'both' : form.bgm ? 'bgm' : form.sfx ? 'sfx' : 'none',
        range: rangeKind.value,
        source: input.source,
    })

    /** Starts an export in the press. The caller has settled any Ready file first. */
    const start = () => {
        if (!ready.value || busyPhase.value) return
        // Remembered choices are written as an export starts, so abandoned ones do not stick.
        settings.exportVideoResolution = form.resolution
        settings.exportVideoFrameRate = form.frameRate
        if (form.quality !== 'custom') settings.exportVideoQuality = form.quality
        settings.exportVideoFormat = form.format
        settings.exportVideoAntialias = form.antialias
        settings.exportVideoRenderScale = form.renderScale
        if (hasAudio.value) settings.exportVideoAudioBitrate = form.audioBitrate
        stopPlayback()
        returnTo = playhead.value
        outcome.value = undefined
        Object.assign(attempt, {
            settings: reportSettings(),
            remembered: rememberedVideoChoices(),
            stage: 'prepare',
            target: 'none',
            hidden: document.hidden,
            pressed: performance.now(),
            pickMs: undefined,
            lengthSeconds: length.value,
            renderStart: undefined,
            renderMs: undefined,
            workMs: undefined,
            size: undefined,
        })
        document.addEventListener('visibilitychange', onHidden)
        busy(true)
        // Sound effects that loaded after this job was made need a job with them.
        if (!sameSfx(loadedSfx(), jobSfx.get(job))) {
            const old = job
            job = newJob()
            viewJob.value = job
            void old.dispose()
        }
        current = job
        picked = undefined
        const used = exportSettings()
        asked = {
            width: used.width,
            height: used.height,
            bgm: used.bgm,
            sfx: used.sfx,
            bytes: bytes.value,
        }
        job.configure(used)
        phase.value = 'preparing'
        void job.start()
    }
    const cancel = () => current?.cancel() ?? false

    /** Ends Ready: deletes an undelivered file, or starts a delivered one's retention. */
    const endReady = async () => {
        const ending = current
        current = undefined
        if (outcome.value?.kind === 'ready') {
            report({
                outcome: 'done',
                sizeBytes: outcome.value.size,
                tookMs: attempt.workMs,
                renderingMs: attempt.renderMs,
            })
        }
        outcome.value = undefined
        phase.value = 'setup'
        try {
            await ending?.dispose()
        } catch (error) {
            // Files whose deletion fails remain unlocked for the next sweep.
            console.error(error)
        }
    }
    /** A failed download or share, shown until the next attempt or change of phase. */
    const deliverFailed = ref<'download' | 'share'>()
    watch(phase, () => {
        deliverFailed.value = undefined
    })
    const deliver = async (how: 'download' | 'share') => {
        const ending = current
        if (!ending || outcome.value?.kind !== 'ready') return
        deliverFailed.value = undefined
        let result
        try {
            result = await ending.deliver(how)
        } catch (error) {
            console.error(error)
            deliverFailed.value = how
            return
        }
        const shown = shownOutcome()
        if (result === 'delivered' && shown?.kind === 'ready') {
            if (attempt.target !== 'memory') attempt.target = how
            outcome.value = { ...shown, delivered: true }
            report({ outcome: 'done', sizeBytes: shown.size })
        }
    }

    // Read again after a wait.
    const shownOutcome = () => outcome.value
    const busyPhase = computed(() =>
        ['preparing', 'exporting', 'cancelling', 'finishing'].includes(phase.value),
    )

    /** Any change to the clip or a setting ends Done, and a delivered Ready. */
    function changed() {
        const shown = outcome.value
        if (!shown || busyPhase.value) return
        if (shown.kind === 'done' || shown.kind === 'failed') {
            outcome.value = undefined
            phase.value = 'setup'
        } else if (shown.delivered) void endReady()
    }
    watch(form, changed)
    /** A view job whose worker failed is replaced, for Retry. */
    const resetViewJob = () => {
        if (busyPhase.value) return
        const old = job
        job = newJob()
        viewJob.value = job
        void old.dispose()
    }
    /** Count each optional part once per dialog, at its first use. */
    const used = { playback: false, advanced: false }
    const use = (part: keyof typeof used) => {
        if (used[part]) return
        used[part] = true
        bump(part === 'playback' ? 'features.videoPlayback' : 'features.videoAdvanced')
    }
    /** The view job draws with the settings as they are now. */
    const configureView = () => {
        if (!busyPhase.value) viewJob.value.configure(exportSettings())
    }

    // --- Playback in the dialog. The scheduler and the playhead loop live in the component.
    const playing = ref(false)
    let stopPlayback = () => {
        playing.value = false
    }
    const setStopPlayback = (stop: () => void) => {
        stopPlayback = stop
    }

    // --- The messages above the footer.
    const coarse = matchMedia('(pointer: coarse)').matches
    const messages = computed(() =>
        exportMessages({
            phase: phase.value,
            outcome: outcome.value,
            deliverFailed: deliverFailed.value,
            coarse,
            form,
            support: support.value,
            limits: limits.value,
            frames: frames.value,
            bytes: bytes.value,
            memoryRoute: memoryRoute.value,
            stopped: settings.exportVideoLastStopped,
            storageNearlyFull: storageNearlyFull.value,
        }),
    )

    const dispose = async () => {
        availability.stop()
        limitsWorker.terminate()
        stopPlayback()
        document.removeEventListener('visibilitychange', onHidden)
        const running = current
        current = undefined
        if (busyPhase.value) busy(false)
        await Promise.all([job.dispose(), running?.dispose()])
    }

    return {
        input,
        form,
        stripEnd,
        wholeEnd,
        bgmEnd,
        hours,
        range,
        rangeKind,
        playhead,
        movePlayhead,
        seek,
        zoomed,
        stripSpan,
        setZoomed,
        span,
        frames,
        length,
        size,
        videoBitrate,
        setBitrate,
        hasAudio,
        fadeLimits,
        support,
        memoryRoute,
        unavailable,
        format,
        ready,
        bytes,
        phase,
        busy: busyPhase,
        outcome,
        progress,
        messages,
        viewJob,
        playing,
        setRange,
        setClipEnd,
        useWhole,
        useBgm,
        useSelection,
        restoreDefaults,
        start,
        cancel,
        endReady,
        deliver,
        changed,
        onFrame,
        setStopPlayback,
        exportSettings,
        configureView,
        resetViewJob,
        use,
        dispose,
        fps,
    }
}

export type ExportDialog = ReturnType<typeof createExportDialog>
