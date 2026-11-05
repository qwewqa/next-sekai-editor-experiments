import type { Engine } from '../platform/detect'
import { exportError } from './error'
import { frameTimestamp } from './timing'
import type { TrialOutput } from './worker/trial'

export type VideoFormat = 'mp4' | 'webm'
export type CodecSettings = {
    format: 'automatic' | VideoFormat
    width: number
    height: number
    frameRate: 30 | 60
    videoBitrate: number
    audioBitrate: number
    bgm: boolean
    sfx: boolean
}

// H.264 Table A-1: level_idc, MaxMBPS, MaxFS and MaxBR (kbps for Main/Baseline).
export const h264Levels = [
    [10, 1485, 99, 64],
    [11, 3000, 396, 192],
    [12, 6000, 396, 384],
    [13, 11880, 396, 768],
    [20, 11880, 396, 2000],
    [21, 19800, 792, 4000],
    [22, 20250, 1620, 4000],
    [30, 40500, 1620, 10000],
    [31, 108000, 3600, 14000],
    [32, 216000, 5120, 20000],
    [40, 245760, 8192, 20000],
    [41, 245760, 8192, 50000],
    [42, 522240, 8704, 50000],
    [50, 589824, 22080, 135000],
    [51, 983040, 36864, 240000],
    [52, 2073600, 36864, 240000],
    [60, 4177920, 139264, 240000],
    [61, 8355840, 139264, 480000],
    [62, 16711680, 139264, 800000],
] as const

export const h264Level = (
    settings: Pick<CodecSettings, 'width' | 'height' | 'frameRate' | 'videoBitrate'>,
    profile: 'high' | 'main' | 'baseline',
) => {
    const w = Math.ceil(settings.width / 16)
    const h = Math.ceil(settings.height / 16)
    return h264Levels.find(
        ([, mbps, fs, br]) =>
            w * h <= fs &&
            w * w <= 8 * fs &&
            h * h <= 8 * fs &&
            w * h * settings.frameRate <= mbps &&
            settings.videoBitrate <= br * 1000 * (profile === 'high' ? 1.25 : 1),
    )?.[0]
}

// VP9 Annex A: level, luma samples/second, picture size, breadth and Mbps.
const vp9Levels = [
    [10, 829440, 36864, 512, 0.2],
    [11, 2764800, 73728, 768, 0.8],
    [20, 4608000, 122880, 960, 1.8],
    [21, 9216000, 245760, 1344, 3.6],
    [30, 20736000, 552960, 2048, 7.2],
    [31, 36864000, 983040, 2752, 12],
    [40, 83558400, 2228224, 4160, 18],
    [41, 160432128, 2228224, 4160, 30],
    [50, 311951360, 8912896, 8384, 60],
    [51, 588251136, 8912896, 8384, 120],
    [52, 1176502272, 8912896, 8384, 180],
    [60, 1176502272, 35651584, 16832, 180],
    [61, 2353004544, 35651584, 16832, 240],
    [62, 4706009088, 35651584, 16832, 480],
] as const

export const configurationKey = (value: unknown): string => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(configurationKey).join(',')}]`
    return `{${Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${JSON.stringify(k)}:${configurationKey(v)}`)
        .join(',')}}`
}

export type CodecSupport =
    | {
          supported: true
          format: VideoFormat
          video: VideoEncoderConfig
          audio?: AudioEncoderConfig
          /** The measured AAC delay in samples, for MP4 with sound. Absent when not measured. */
          aacDelay?: number
      }
    | {
          supported: false
          reason: 'videoEncoder' | 'audioEncoder' | 'videoConfig' | 'videoTrial' | 'audioConfig'
      }

export type TrialConfig = VideoEncoderConfig & { framerate: 30 | 60 }

export type EncoderProbes = {
    video?: (config: VideoEncoderConfig) => Promise<{ supported?: boolean }>
    audio?: (config: AudioEncoderConfig) => Promise<{ supported?: boolean }>
    /** Encodes a few frames and reports whether the export's adapter and muxer take the output. */
    trial?: (config: TrialConfig, signal: AbortSignal) => Promise<boolean>
    /** Measures the AAC delay in samples, for a configuration that passed `audio`. */
    aacDelay?: (config: AudioEncoderConfig, signal?: AbortSignal) => Promise<number>
}

/**
 * The abort reason of an availability update that a newer one replaced. `closed` aborts on stop.
 */
class Superseded extends Error {
    constructor(readonly closed: AbortSignal) {
        super('A newer update replaced this one')
    }
}

/** A queue shared by several kinds of work. Each run starts once the previous run has ended. */
export type Lane = { tail: Promise<unknown> }
export const createLane = (): Lane => ({ tail: Promise.resolve() })

export type SharedWorkOptions = {
    /**
     * False for work that cannot be stopped once started. It then runs on when its last caller
     * leaves, holds the lane until it ends, and its result is kept.
     */
    stoppable?: boolean
    /** Called once for a run still going after `ms`, with its key. */
    stall?: { ms: number; report: (key: string) => void }
}

/**
 * Work shared by callers with the same key. In a lane, each run waits for the previous one to
 * end. A caller leaves when its signal aborts. When the last caller leaves, the work stops and is
 * forgotten, and a queued run is skipped. Started work whose last caller was superseded runs on
 * until it ends or `Superseded.closed` aborts. A result is kept. A failure is forgotten, so a
 * later call runs the work again. `kept` gives a kept result without running the work.
 */
export const createSharedWork = <T>(
    lane?: Lane,
    { stoppable = true, stall }: SharedWorkOptions = {},
) => {
    type Entry = {
        result: Promise<T>
        callers: number
        started: boolean
        settled: boolean
        value?: T
        stop: AbortController
    }
    const entries = new Map<string, Entry>()
    const start = (key: string, run: (signal: AbortSignal) => Promise<T>, stop: AbortSignal) => {
        const result = run(stop)
        if (stall) {
            const timer = setTimeout(() => {
                stall.report(key)
            }, stall.ms)
            const clear = () => {
                clearTimeout(timer)
            }
            result.then(clear, clear)
        }
        return result
    }
    const call = (key: string, run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal) => {
        signal?.throwIfAborted()
        let entry = entries.get(key)
        if (!entry) {
            const stop = new AbortController()
            const created: Entry = {
                result: lane
                    ? lane.tail.then(() => {
                          stop.signal.throwIfAborted()
                          created.started = true
                          return start(key, run, stop.signal)
                      })
                    : start(key, run, stop.signal),
                callers: 0,
                started: !lane,
                settled: false,
                stop,
            }
            entry = created
            entries.set(key, created)
            // The next run waits for this one's work to end, whether or not anyone still waits.
            if (lane) lane.tail = created.result.catch(() => undefined)
            created.result.then(
                (value) => {
                    created.settled = true
                    created.value = value
                },
                () => {
                    created.settled = true
                    if (entries.get(key) === created) entries.delete(key)
                },
            )
        }
        const joined = entry
        joined.callers++
        if (!signal) return joined.result
        const cancel = () => {
            if (joined.settled || joined.callers || (joined.started && !stoppable)) return
            if (entries.get(key) === joined) entries.delete(key)
            joined.stop.abort()
        }
        return new Promise<T>((resolve, reject) => {
            const leave = () => {
                joined.callers--
                const reason = signal.reason as Error
                if (joined.started && reason instanceof Superseded && !reason.closed.aborted)
                    reason.closed.addEventListener('abort', cancel, { once: true })
                else cancel()
                reject(reason)
            }
            signal.addEventListener('abort', leave, { once: true })
            joined.result.then(
                (value) => {
                    signal.removeEventListener('abort', leave)
                    resolve(value)
                },
                (error: unknown) => {
                    signal.removeEventListener('abort', leave)
                    reject(exportError(error))
                },
            )
        })
    }
    return Object.assign(call, { kept: (key: string) => entries.get(key)?.value })
}

// isConfigSupported can accept a configuration whose output the export cannot use. Firefox's
// H.264 encoder writes a malformed SPS. The frames are raw YUV: gray with a moving square.
const trialEncode = async (config: TrialConfig, signal: AbortSignal) => {
    const frames = 3
    const at = (i: number) => frameTimestamp(i, config.framerate)
    const outputs: TrialOutput[] = []
    const errors: DOMException[] = []
    let encoder: VideoEncoder | undefined
    const close = () => {
        if (encoder && encoder.state !== 'closed') encoder.close()
    }
    signal.addEventListener('abort', close, { once: true })
    try {
        signal.throwIfAborted()
        encoder = new VideoEncoder({
            output: (chunk, metadata) => {
                outputs.push({ chunk, metadata })
            },
            error: (error) => {
                errors.push(error)
            },
        })
        encoder.configure(config)
        const { width, height } = config
        const luma = width * height
        const chroma = Math.ceil(width / 2) * Math.ceil(height / 2)
        for (let i = 0; i < frames; i++) {
            const data = new Uint8Array(luma + 2 * chroma).fill(128)
            for (let y = 16; y < Math.min(32, height); y++)
                data.fill(
                    235,
                    y * width + 16 * i,
                    Math.min((y + 1) * width, y * width + 16 * i + 16),
                )
            const frame = new VideoFrame(data, {
                format: 'I420',
                codedWidth: width,
                codedHeight: height,
                timestamp: at(i),
                duration: at(i + 1) - at(i),
            })
            try {
                encoder.encode(frame, { keyFrame: i === 0 })
            } finally {
                frame.close()
            }
        }
        await encoder.flush()
    } catch {
        signal.throwIfAborted()
        // Any other failure counts as unsupported, so the next configuration is tried.
        return false
    } finally {
        signal.removeEventListener('abort', close)
        close()
    }
    signal.throwIfAborted()
    if (errors.length) return false
    const { usableTrial } = await import('./worker/trial')
    return usableTrial(config, outputs, frames)
}

export const browserEncoderProbes = (): EncoderProbes => ({
    video:
        typeof VideoEncoder === 'undefined' ? undefined : (c) => VideoEncoder.isConfigSupported(c),
    audio:
        typeof AudioEncoder === 'undefined' ? undefined : (c) => AudioEncoder.isConfigSupported(c),
    trial: typeof VideoEncoder === 'undefined' ? undefined : trialEncode,
})

/**
 * On macOS 27 the GPU sandbox makes VideoToolbox use its software H.264 encoder. In High and
 * Main that encoder buffers more frames than the WebCodecs encode queue allows, so encoding
 * stalls (https://webkit.org/b/324827).
 */
export const h264Profiles = (engine?: Engine) =>
    engine === 'webkit'
        ? ([['baseline', '4240']] as const)
        : ([
              ['high', '6400'],
              ['main', '4d00'],
              ['baseline', '4200'],
          ] as const)

export type ResolveOptions = {
    /**
     * When false, no trial or AAC measurement runs. isConfigSupported decides, and a
     * configuration whose trial already failed in this page stays refused.
     */
    trial?: boolean
    /** When it aborts, the caller leaves shared trials and measurements. */
    signal?: AbortSignal
}

/**
 * How long a video support query runs before a diagnostic records it. No other query or trial
 * starts until it ends.
 */
const STALL_MS = 10_000

/**
 * The page owner keeps this instance for both settings and export jobs. `diagnose` records a
 * support query that stalls the lane.
 */
export const createCodecProbes = (
    probes: EncoderProbes = browserEncoderProbes(),
    engine?: Engine,
    { diagnose, stallMs = STALL_MS }: { diagnose?: (text: string) => void; stallMs?: number } = {},
) => {
    const cache = new Map<string, Promise<boolean>>()
    const refused = (error: unknown) =>
        error instanceof TypeError ||
        (error instanceof DOMException && error.name === 'NotSupportedError')
    const probe = <C>(kind: string, config: C, run: (c: C) => Promise<{ supported?: boolean }>) => {
        const key = kind + configurationKey(config)
        let result = cache.get(key)
        if (!result) {
            // A query that throws counts as unsupported. Only a refused configuration is kept;
            // after any other error, the next call asks again.
            result = (async () => !!(await run(config)).supported)().catch((error: unknown) => {
                if (!refused(error)) cache.delete(key)
                return false
            })
            cache.set(key, result)
        }
        return result
    }
    // In Chromium on Windows a video support query creates an encoder, and a 2160p one takes over
    // 1 GB for a moment. A trial holds an encoder and full-size frames. Both therefore share one
    // lane, and at most one of them runs at a time. A query cannot be stopped, so it holds the
    // lane until it ends.
    const lane = createLane()
    const trials = createSharedWork<boolean>(lane)
    const queries = createSharedWork<boolean>(lane, {
        stoppable: false,
        stall: diagnose && {
            ms: stallMs,
            report: (key) => {
                diagnose(`Video support query still running after ${stallMs / 1000} s: ${key}`)
            },
        },
    })
    /**
     * Rejects with the signal's reason once it aborts. As in `probe`, a refused configuration is
     * kept, and any other failure counts as unsupported for this call only.
     */
    const videoQuery = async (
        run: NonNullable<EncoderProbes['video']>,
        config: VideoEncoderConfig,
        signal?: AbortSignal,
    ) => {
        try {
            return await queries(
                configurationKey(config),
                async () => {
                    try {
                        return !!(await run(config)).supported
                    } catch (error) {
                        if (refused(error)) return false
                        throw error
                    }
                },
                signal,
            )
        } catch (error) {
            if (signal?.aborted) throw error
            return false
        }
    }
    const passesTrial = async (config: TrialConfig, signal?: AbortSignal) => {
        const run = probes.trial
        if (!run) return true
        return trials(configurationKey(config), (stop) => run(config, stop), signal)
    }
    const kept = (config: TrialConfig) =>
        probes.trial ? trials.kept(configurationKey(config)) : undefined
    const resolveFormat = async (
        s: CodecSettings,
        format: VideoFormat,
        trial: boolean,
        signal?: AbortSignal,
    ): Promise<CodecSupport> => {
        if (!probes.video) return { supported: false, reason: 'videoEncoder' }
        let audio: AudioEncoderConfig | undefined
        if (s.bgm || s.sfx) {
            if (!probes.audio) return { supported: false, reason: 'audioEncoder' }
            audio = {
                codec: format === 'mp4' ? 'mp4a.40.2' : 'opus',
                sampleRate: 48000,
                numberOfChannels: 2,
                bitrate: s.audioBitrate,
                bitrateMode: 'variable',
            }
            if (!(await probe('audio', audio, probes.audio)))
                return { supported: false, reason: 'audioConfig' }
            signal?.throwIfAborted()
        }
        const common: Omit<TrialConfig, 'codec'> = {
            width: s.width,
            height: s.height,
            framerate: s.frameRate,
            bitrate: s.videoBitrate,
            bitrateMode: 'variable',
            latencyMode: 'quality',
            hardwareAcceleration: 'no-preference',
        }
        const configs: TrialConfig[] = []
        if (format === 'mp4') {
            for (const [profile, id] of h264Profiles(engine)) {
                const level = h264Level(s, profile)
                if (level !== undefined)
                    configs.push({
                        ...common,
                        codec: `avc1.${id}${level.toString(16).padStart(2, '0')}`,
                        avc: { format: 'avc' },
                    })
            }
        } else {
            const pixels = s.width * s.height
            const level = vp9Levels.find(
                ([, rate, size, breadth, mbps]) =>
                    pixels <= size &&
                    pixels * s.frameRate <= rate &&
                    Math.max(s.width, s.height) <= breadth &&
                    s.videoBitrate <= mbps * 1e6,
            )?.[0]
            if (level !== undefined) configs.push({ ...common, codec: `vp09.00.${level}.08` })
        }
        let accepted = false
        for (const video of configs) {
            const probed = await videoQuery(probes.video, video, signal)
            signal?.throwIfAborted()
            if (!probed) continue
            accepted = true
            if (!(trial ? await passesTrial(video, signal) : (kept(video) ?? true))) continue
            // Without a measured delay, the export places AAC with an estimate and warns.
            let aacDelay: number | undefined
            if (audio && format === 'mp4' && trial && probes.aacDelay) {
                try {
                    aacDelay = await probes.aacDelay(audio, signal)
                } catch {
                    signal?.throwIfAborted()
                }
            }
            return {
                supported: true,
                format,
                video,
                audio,
                ...(aacDelay === undefined ? {} : { aacDelay }),
            }
        }
        return { supported: false, reason: accepted ? 'videoTrial' : 'videoConfig' }
    }
    /** Rejects with the signal's reason once it aborts. */
    const resolve = async (
        s: CodecSettings,
        { trial = true, signal }: ResolveOptions = {},
    ): Promise<CodecSupport> => {
        if (s.format !== 'automatic') return resolveFormat(s, s.format, trial, signal)
        const mp4 = await resolveFormat(s, 'mp4', trial, signal)
        return mp4.supported ? mp4 : resolveFormat(s, 'webm', trial, signal)
    }
    return { resolve }
}

/**
 * Each update resolves the selection with trials, then every offered choice without them. A late
 * result changes nothing.
 */
export const createCodecAvailability = (probes: ReturnType<typeof createCodecProbes>) => {
    type State = { pending: boolean; current?: CodecSupport; choices: Record<string, CodecSupport> }
    let state: State = { pending: true, choices: {} }
    let shownChoices: State['choices'] = {}
    let latest: AbortController | undefined
    const closed = new AbortController()
    return {
        get state() {
            return state
        },
        /** Stops every update's shared work at once. Later updates do nothing. */
        stop() {
            closed.abort()
            latest?.abort()
        },
        /** `changed` receives the selection, then the choices, while the update is the latest. */
        async update(
            settings: CodecSettings,
            choices: Record<string, Partial<CodecSettings>>,
            changed: (state: State) => void = () => undefined,
        ) {
            if (closed.signal.aborted) return state
            // A newer update leaves this one's shared work at once.
            latest?.abort(new Superseded(closed.signal))
            const controller = (latest = new AbortController())
            const { signal } = controller
            const wanted = () => !signal.aborted
            const publish = (next: State) => {
                if (!wanted()) return
                state = next
                changed(next)
            }
            state = { pending: true, choices: {} }
            try {
                // The selection first, so that Export does not wait for the choices.
                const current = await probes.resolve({ ...settings }, { signal })
                const selected = configurationKey(settings)
                const equal = (patch: Partial<CodecSettings>) =>
                    configurationKey({ ...settings, ...patch }) === selected
                const own = Object.fromEntries(
                    Object.entries(choices)
                        .filter(([, patch]) => equal(patch))
                        .map(([key]) => [key, current]),
                )
                publish({ pending: false, current, choices: { ...shownChoices, ...own } })
                const resolved = await Promise.all(
                    Object.entries(choices).map(
                        async ([key, patch]) =>
                            [
                                key,
                                equal(patch)
                                    ? current
                                    : await probes.resolve(
                                          { ...settings, ...patch },
                                          { trial: false, signal },
                                      ),
                            ] as const,
                    ),
                )
                if (wanted()) shownChoices = Object.fromEntries(resolved)
                publish({ pending: false, current, choices: shownChoices })
            } catch (error) {
                if (wanted()) throw error
            }
            return state
        },
    }
}

export const outputSize = (height: number, aspect: number) => ({
    width: 2 * Math.round((height * aspect) / 2),
    height,
})
