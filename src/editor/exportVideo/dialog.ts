// The Export Video dialog's state: the clip, the settings, the job and its outcome. The dialog
// renders this; the job owns every resource of an export (src/exportVideo/job.ts).

import { computed, reactive, ref, shallowRef, watch, type Ref } from 'vue'
import { busy } from '../../analytics/tally'
import {
    createCodecAvailability,
    deviceClass,
    fitsPixelBudget,
    outputSize,
    qualifiedPixelBudgets,
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
import {
    createExportJob,
    createExportServices,
    type JobDestination,
    type JobState,
} from '../../exportVideo/job'
import type { ExportSettings } from '../../exportVideo/types'
import { bgmEndOf } from '../../levelData/statistics'
import { platform } from '../../platform'
import { loadedSfx, sfxSettled } from '../../player'
import { previewAspectRatios, previewNoteSpeed } from '../../preview/options'
import { settings } from '../../settings'
import type { State } from '../../state'
import type { Bgm } from '../../state/bgm'
import type { Entity } from '../../state/entities'
import { beatToTime } from '../../state/integrals/bpms'
import { copyExportAssets } from './assets'
import {
    clampRange,
    clipLength,
    frameCount,
    lastObjectBeat,
    selectionRange,
    selectionSpan,
    setEnd,
    stripEndOf,
    toFrame,
    wholeChartEnd,
    wholeRange,
    type ClipRange,
    type RangeKind,
} from './clipRange'
import { clearDeviceLimit, clearStops, countStoppedExports } from './deviceLimit'
import type { ExportVideoEnv } from './env'
import { describeVideoFailure, type VideoFailure } from './failure'
import { videoReport, type VideoReportEnd, type VideoReportSettings } from './report'
import { videoFileName } from './videoName'

/** One per page: the probe and AAC calibration caches outlive each dialog. */
let services: ReturnType<typeof createExportServices> | undefined

/** The range each chain used last in this page, by its kind. */
const rangeMemory = new Map<string, { kind: RangeKind; range: ClipRange }>()

export type DialogInput = {
    snapshot: State
    source: 'live' | 'peek'
    chain: string
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

/** An export's end that the footer shows until the next change. */
export type Outcome =
    | { kind: 'done'; name: string; size?: number }
    | { kind: 'ready'; size: number; delivered: boolean; shareable: boolean }
    | { kind: 'failed'; failure: VideoFailure }

export type Unavailable = 'browser' | 'device'

const formFromSettings = (look: DialogInput['look']) => ({
    aspect: previewAspectRatios.find(([, value]) => value === look.aspect)?.[1] ?? 16 / 9,
    resolution: settings.exportVideoResolution,
    frameRate: settings.exportVideoFrameRate,
    quality: settings.exportVideoQuality as Quality | 'custom',
    customBitrate: 8,
    bgm: true,
    sfx: true,
    format: settings.exportVideoFormat,
    antialias: settings.exportVideoAntialias,
    renderScale: settings.exportVideoRenderScale,
    noteSpeed: look.noteSpeed,
    showEffects: look.showEffects,
    showCombo: look.showCombo,
    fadeIn: 0,
    fadeOut: 0,
    bgmVolume: settings.playBgmVolume,
    sfxVolume: settings.playSfxVolume,
    audioBitrate: settings.exportVideoAudioBitrate,
})
export type DialogForm = ReturnType<typeof formFromSettings>

/** What the GPU allows, read once from a throwaway context. */
const graphicsLimits = () => {
    try {
        const gl = new OffscreenCanvas(1, 1).getContext('webgl2')
        if (!gl) return undefined
        const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array
        const limits = {
            viewport: [viewport[0] ?? 0, viewport[1] ?? 0] as const,
            renderbuffer: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number,
        }
        gl.getExtension('WEBGL_lose_context')?.loseContext()
        return limits
    } catch {
        return undefined
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
        bgmEnd,
    )
    const stripEnd = stripEndOf(wholeEnd)
    const remembered = rangeMemory.get(input.chain)
    const rangeKind = ref<RangeKind>(remembered?.kind ?? 'whole')
    const range = ref<ClipRange>(
        remembered && remembered.kind !== 'whole'
            ? clampRange(remembered.range, stripEnd, fps())
            : wholeRange(wholeEnd, fps()),
    )
    const playhead = ref(Math.min(stripEnd, Math.max(0, toFrame(input.cursor, fps()))))
    const span = computed(() => selectionSpan(input.selection, input.snapshot.bpms))
    const hours = stripEnd >= 3600
    const remember = () =>
        rangeMemory.set(input.chain, { kind: rangeKind.value, range: range.value })

    const setRange = (next: ClipRange, kind: RangeKind = 'custom') => {
        range.value = clampRange(next, stripEnd, fps())
        rangeKind.value = kind
        remember()
        changed()
    }
    const setClipEnd = (end: 'in' | 'out', time: number) => {
        range.value = setEnd(range.value, end, time, stripEnd, fps())
        rangeKind.value = 'custom'
        remember()
        changed()
    }
    const useWhole = () => {
        setRange(wholeRange(wholeEnd, fps()), 'whole')
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
            support.value = { ...support.value, pending: true }
            const state = await availability.update(value, choices)
            if (state === availability.state) support.value = state
        },
        { immediate: true, deep: true },
    )
    const limits = graphicsLimits()
    const device = deviceClass({
        deviceMemory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
        coarsePointer: matchMedia('(pointer: coarse)').matches,
        screenWidth: screen.width,
        screenHeight: screen.height,
    })
    const fits = (resolution: Resolution, scale: number) =>
        !!limits &&
        fitsPixelBudget(
            outputSize(resolution, form.aspect),
            scale,
            {
                ...limits,
                deviceLimit: settings.exportVideoPixelLimit || undefined,
            },
            device,
            input.env.budgets ?? qualifiedPixelBudgets,
        )
    const browserOk = (key: string) => {
        const choice = support.value.choices[key]
        return !choice || choice.supported
    }
    const unavailable = computed(() => {
        const out: Record<string, Unavailable | undefined> = {}
        for (const resolution of RESOLUTIONS)
            out[`resolution:${resolution}`] = !fits(resolution, form.renderScale)
                ? 'device'
                : browserOk(`resolution:${resolution}`)
                  ? undefined
                  : 'browser'
        for (const scale of [1, 1.5, 2] as const)
            out[`renderScale:${scale}`] = fits(form.resolution, scale) ? undefined : 'device'
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
            fits(form.resolution, form.renderScale) &&
            frames.value > 0 &&
            // The sound effects an export mixes are taken as it starts.
            (!form.sfx || sfxSettled.value),
    )

    // --- Estimates.
    const renderPixels = computed(
        () =>
            Math.round(size.value.width * form.renderScale) *
            Math.round(size.value.height * form.renderScale),
    )
    const bytes = computed(() =>
        estimateBytes(length.value, videoBitrate.value, hasAudio.value ? form.audioBitrate : 0),
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
        const look = input.look
        Object.assign(form, {
            ...formFromSettings(look),
            resolution: 1080,
            frameRate: 30,
            quality: 'standard',
            format: 'automatic',
            antialias: true,
            renderScale: 1,
            audioBitrate: 192_000,
            bgm: !input.bgmMissing,
            sfx: true,
        } satisfies Partial<DialogForm>)
        clearDeviceLimit()
        stoppedLine.value = false
    }

    // --- The job, its frames and its outcome.
    const phase = ref<Phase>('setup')
    const outcome = shallowRef<Outcome>()
    const progress = ref<{ fraction: number; eta?: number }>({ fraction: 0 })
    const stoppedLine = ref(false)
    void countStoppedExports().then((lowered) => {
        if (lowered) stoppedLine.value = true
    })
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
            destination: (signal, id) => destinationFor(signal, id),
            worker: () => input.env.worker(),
            changed: (state) => {
                if (created === current) onState(state)
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
    const destinationFor = async (signal: AbortSignal, id: string): Promise<JobDestination> => {
        const name = fileName()
        const destination = await input.env.destination({
            signal,
            id,
            name,
            format: format.value,
            estimatedBytes: bytes.value,
            dismissed: () => {
                attempt.target = 'none'
                current?.cancel()
            },
        })
        const worker = destination.worker
        picked =
            worker.kind === 'picked'
                ? { name: worker.pick.handle.name, handle: worker.pick.handle }
                : { name, staged: worker.kind === 'staged' }
        attempt.target =
            worker.kind === 'picked' ? 'picker' : worker.kind === 'memory' ? 'memory' : 'none'
        attempt.stage = 'render'
        return destination
    }
    const fileName = () =>
        videoFileName(
            input.stem,
            rangeKind.value === 'whole' ? undefined : range.value,
            format.value,
        )

    // --- The usage event's attempt: built here, recorded once the catalogue has the event.
    const attempt: {
        settings?: VideoReportSettings
        stage: NonNullable<VideoReportEnd['stage']>
        target: VideoReportEnd['target']
        hidden: boolean
        pressed: number
        renderStart?: number
        renderMs?: number
        workMs?: number
        size?: number
    } = { stage: 'prepare', target: 'none', hidden: false, pressed: 0 }
    const reports: ReturnType<typeof videoReport>[] = []
    const report = (end: Omit<VideoReportEnd, 'target' | 'hidden' | 'lengthSeconds'>) => {
        if (!attempt.settings) return
        reports.push(
            videoReport(attempt.settings, {
                ...end,
                target: attempt.target,
                hidden: attempt.hidden,
                lengthSeconds: length.value,
            }),
        )
        attempt.settings = undefined
    }
    const onHidden = () => {
        if (document.hidden) attempt.hidden = true
    }

    let returnTo = 0
    const onState = (state: JobState) => {
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
        // The attempt ended.
        busy(false)
        document.removeEventListener('visibilitychange', onHidden)
        attempt.workMs = performance.now() - attempt.pressed
        playhead.value = returnTo
        const ended = current
        if (state.phase === 'cancelled') {
            report({ outcome: 'cancelled', stage: attempt.stage })
            outcome.value = undefined
            phase.value = 'setup'
            current = undefined
            retire(ended)
        } else if (state.phase === 'failed') {
            const failure = describeVideoFailure(state.error, fileName())
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
                    delivered: false,
                    // Share… is offered for a coarse pointer, as Share Image is.
                    shareable:
                        !!picked?.staged &&
                        matchMedia('(pointer: coarse)').matches &&
                        (platform.videoOutput?.canShare(state.file) ?? false),
                }
                phase.value = 'ready'
            } else {
                void finishDone('result' in state ? state.result : undefined)
            }
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
        clearStops(renderPixels.value)
    }
    const finishDone = async (result: unknown) => {
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
        outcome.value = { kind: 'done', name, size }
        phase.value = 'done'
        const ended = current
        current = undefined
        retire(ended)
    }

    const reportSettings = (): VideoReportSettings => ({
        format: format.value,
        support: format.value === 'webm' && form.format === 'automatic' ? 'webmOnly' : 'full',
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
            stage: 'pick',
            target: 'none',
            hidden: document.hidden,
            pressed: performance.now(),
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
        job.configure(exportSettings())
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
        await ending?.dispose()
    }
    const deliver = async (how: 'download' | 'share') => {
        const ending = current
        if (!ending || outcome.value?.kind !== 'ready') return 'cancelled' as const
        const result = await ending.deliver(how)
        const shown = shownOutcome()
        if (result === 'delivered' && shown?.kind === 'ready') {
            attempt.target = how
            outcome.value = { ...shown, delivered: true }
        }
        return result
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
    /** Which optional parts were used, for the usage counters once they exist. */
    const used = { playback: false, advanced: false }
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

    const dispose = async () => {
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
        span,
        frames,
        length,
        size,
        videoBitrate,
        setBitrate,
        hasAudio,
        support,
        unavailable,
        format,
        ready,
        bytes,
        phase,
        busy: busyPhase,
        outcome,
        progress,
        stoppedLine,
        viewJob,
        playing,
        reports,
        setRange,
        setClipEnd,
        useWhole,
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
        used,
        dispose,
        fps,
    }
}

export type ExportDialog = ReturnType<typeof createExportDialog>
export type { Ref }
export const NOTE_SPEED = previewNoteSpeed
