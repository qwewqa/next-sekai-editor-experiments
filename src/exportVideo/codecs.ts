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
          /** The measured AAC delay in samples, for MP4 with sound. */
          aacDelay?: number
      }
    | { supported: false; reason: 'videoEncoder' | 'audioEncoder' | 'videoConfig' | 'audioConfig' }

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
 * Work shared by callers with the same key. When every caller has left through its signal, the
 * work is aborted and forgotten; so is a failure, so a later call runs it again.
 */
export const createSharedWork = <T>() => {
    type Entry = { result: Promise<T>; callers: number; settled: boolean; stop: AbortController }
    const entries = new Map<string, Entry>()
    return (key: string, run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal) => {
        signal?.throwIfAborted()
        let entry = entries.get(key)
        if (!entry) {
            const stop = new AbortController()
            const created: Entry = { result: run(stop.signal), callers: 0, settled: false, stop }
            entry = created
            entries.set(key, created)
            created.result.then(
                () => {
                    created.settled = true
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
        return new Promise<T>((resolve, reject) => {
            const leave = () => {
                joined.callers--
                if (!joined.settled && !joined.callers) {
                    if (entries.get(key) === joined) entries.delete(key)
                    joined.stop.abort()
                }
                reject(signal.reason as Error)
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
}

// isConfigSupported can accept a configuration whose output the export cannot use. Firefox's
// H.264 encoder shifts timestamps and writes a malformed SPS.
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
        const canvas = new OffscreenCanvas(config.width, config.height)
        const context = canvas.getContext('2d')
        if (!context) throw new Error('2D canvas is unavailable')
        encoder.configure(config)
        for (let i = 0; i < frames; i++) {
            context.fillStyle = '#808080'
            context.fillRect(0, 0, config.width, config.height)
            context.fillStyle = '#ffffff'
            context.fillRect(16 * i, 16, 16, 16)
            const frame = new VideoFrame(canvas, { timestamp: at(i), duration: at(i + 1) - at(i) })
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
 * In other profiles, WebKit's H.264 encoder stops producing output after a few frames, later
 * than a trial encode runs.
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
    /** When false, only isConfigSupported decides. */
    trial?: boolean
    /** The caller no longer wants the result: it leaves shared trials and measurements. */
    signal?: AbortSignal
}

/** The page owner keeps this instance for both settings and export jobs. */
export const createCodecProbes = (
    probes: EncoderProbes = browserEncoderProbes(),
    engine?: Engine,
) => {
    const cache = new Map<string, Promise<boolean>>()
    const probe = <C>(kind: string, config: C, run: (c: C) => Promise<{ supported?: boolean }>) => {
        const key = kind + configurationKey(config)
        let result = cache.get(key)
        if (!result) {
            result = run(config)
                .then((r) => !!r.supported)
                .catch((error: unknown) => {
                    if (
                        error instanceof TypeError ||
                        (error instanceof DOMException && error.name === 'NotSupportedError')
                    )
                        return false
                    cache.delete(key)
                    throw error
                })
            cache.set(key, result)
        }
        return result
    }
    const trials = createSharedWork<boolean>()
    // Trials run one at a time, since each holds an encoder and full-size frames. One that no
    // caller still wants by its turn is skipped.
    let queue: Promise<unknown> = Promise.resolve()
    const passesTrial = async (config: TrialConfig, signal?: AbortSignal) => {
        const run = probes.trial
        if (!run) return true
        return trials(
            configurationKey(config),
            (stop) => {
                const result = queue.then(() => {
                    stop.throwIfAborted()
                    return run(config, stop)
                })
                queue = result.catch(() => undefined)
                return result
            },
            signal,
        )
    }
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
        // Without a measured delay, AAC cannot be placed, so MP4 with sound is unavailable.
        let aacDelay: number | undefined
        if (audio && format === 'mp4' && trial && probes.aacDelay) {
            try {
                aacDelay = await probes.aacDelay(audio, signal)
            } catch {
                signal?.throwIfAborted()
                return { supported: false, reason: 'audioConfig' }
            }
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
        for (const video of configs) {
            const probed = await probe('video', video, probes.video)
            signal?.throwIfAborted()
            if (probed && (!trial || (await passesTrial(video, signal))))
                return {
                    supported: true,
                    format,
                    video,
                    audio,
                    ...(aacDelay === undefined ? {} : { aacDelay }),
                }
        }
        return { supported: false, reason: 'videoConfig' }
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

/** Each update resolves the selection, then all offered choices. A late result changes nothing. */
export const createCodecAvailability = (probes: ReturnType<typeof createCodecProbes>) => {
    type State = { pending: boolean; current?: CodecSupport; choices: Record<string, CodecSupport> }
    let state: State = { pending: true, choices: {} }
    let shownChoices: State['choices'] = {}
    let latest: AbortController | undefined
    const running = new Set<AbortController>()
    const leave = (controller?: AbortController) => {
        controller?.abort()
        if (controller) running.delete(controller)
    }
    let stopped = false
    return {
        get state() {
            return state
        },
        /** Leaves every update's shared work at once. Later updates do nothing. */
        stop() {
            stopped = true
            running.forEach(leave)
        },
        /** `changed` receives the selection, then the choices, while the update is the latest. */
        async update(
            settings: CodecSettings,
            choices: Record<string, Partial<CodecSettings>>,
            changed: (state: State) => void = () => undefined,
        ) {
            if (stopped) return state
            const previous = latest
            const controller = (latest = new AbortController())
            running.add(controller)
            const { signal } = controller
            const wanted = () => latest === controller && !signal.aborted
            const publish = (next: State) => {
                if (!wanted()) return
                state = next
                changed(next)
            }
            state = { pending: true, choices: {} }
            try {
                // The selection first, so that Export waits only for its own probes and trials.
                // The previous update stops publishing at once, but leaves its shared trials
                // and measurements only after this selection resolves, so work both need
                // keeps a caller.
                const current = await probes
                    .resolve({ ...settings }, { signal })
                    .finally(() => leave(previous))
                publish({ pending: false, current, choices: shownChoices })
                // Trials encode full-size frames, so choices at another size or frame rate
                // skip them.
                const sameVideo = (choice: CodecSettings) =>
                    (['width', 'height', 'frameRate'] as const).every(
                        (key) => choice[key] === settings[key],
                    )
                const resolved = await Promise.all(
                    Object.entries(choices).map(async ([key, patch]) => {
                        const choice = { ...settings, ...patch }
                        const trial = sameVideo(choice)
                        return [key, await probes.resolve(choice, { trial, signal })] as const
                    }),
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
