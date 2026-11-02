import type { Engine } from '../platform/detect'
import { frameTimestamp } from './timing'

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
      }
    | { supported: false; reason: 'videoEncoder' | 'audioEncoder' | 'videoConfig' | 'audioConfig' }

export type TrialConfig = VideoEncoderConfig & { framerate: 30 | 60 }

export type EncoderProbes = {
    video?: (config: VideoEncoderConfig) => Promise<{ supported?: boolean }>
    audio?: (config: AudioEncoderConfig) => Promise<{ supported?: boolean }>
    /** Encodes a few frames and reports whether the frame loop could use the output. */
    trial?: (config: TrialConfig) => Promise<boolean>
}

export type TrialChunk = {
    type: EncodedVideoChunkType
    timestamp: number
    duration: number | null
    decoderConfig?: VideoDecoderConfig
}

/** profile_idc of the first SPS in an AVC configuration record, if its NAL header is valid. */
const avcProfile = (description: AllowSharedBufferSource | undefined) => {
    if (!description) return undefined
    const bytes = ArrayBuffer.isView(description)
        ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
        : new Uint8Array(description)
    const size = ((bytes[6] ?? 0) << 8) | (bytes[7] ?? 0)
    if (bytes[0] !== 1 || !((bytes[5] ?? 0) & 31) || size < 2 || 8 + size > bytes.length)
        return undefined
    // forbidden_zero_bit 0 and nal_unit_type 7.
    return ((bytes[8] ?? 0) & 0x9f) === 7 ? bytes[9] : undefined
}

/** Whether the frame loop accepts this output for `frames` frames submitted at the frame rate. */
export const usableTrial = (config: TrialConfig, chunks: readonly TrialChunk[], frames: number) => {
    const at = (i: number) => frameTimestamp(i, config.framerate)
    const decoder = chunks[0]?.decoderConfig
    return (
        chunks.length === frames &&
        chunks[0]?.type === 'key' &&
        decoder?.codedWidth === config.width &&
        decoder.codedHeight === config.height &&
        chunks.every((c, i) => c.timestamp === at(i) && c.duration === at(i + 1) - at(i)) &&
        (!config.codec.startsWith('avc1.') ||
            avcProfile(decoder.description) === parseInt(config.codec.slice(5, 7), 16))
    )
}

// isConfigSupported can accept a configuration whose output the export cannot use. Firefox's
// H.264 encoder shifts and reorders timestamps and writes a malformed SPS.
const trialEncode = async (config: TrialConfig) => {
    const frames = 3
    const at = (i: number) => frameTimestamp(i, config.framerate)
    const chunks: TrialChunk[] = []
    let encoder: VideoEncoder | undefined
    try {
        encoder = new VideoEncoder({
            output: (chunk, metadata) => {
                const { type, timestamp, duration } = chunk
                chunks.push({ type, timestamp, duration, decoderConfig: metadata?.decoderConfig })
            },
            error: () => undefined,
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
        // Any failure counts as unsupported, so the next configuration is tried.
        return false
    } finally {
        if (encoder && encoder.state !== 'closed') encoder.close()
    }
    return usableTrial(config, chunks, frames)
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

/** A queued trial that no update or export still needs is skipped and not cached. */
class Superseded extends Error {}

export type ResolveOptions = {
    /** When false, only isConfigSupported decides. */
    trial?: boolean
    /** Whether the caller still wants the result. */
    wanted?: () => boolean
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
    // A trial's outcome depends on the encoder, the codec string, the size and the frame rate.
    // Bitrate only selects the level in the codec string, so the key leaves it out.
    // The callers are kept only until the trial starts.
    type Trial = { callers?: (() => boolean)[]; result: Promise<boolean> }
    const trials = new Map<string, Trial>()
    // Trials run one at a time, since each holds an encoder and full-size frames.
    let queue: Promise<unknown> = Promise.resolve()
    const passesTrial = (config: TrialConfig, wanted: () => boolean) => {
        const run = probes.trial
        if (!run) return true
        const key = configurationKey({ ...config, bitrate: undefined })
        const cached = trials.get(key)
        if (cached) {
            cached.callers?.push(wanted)
            return cached.result
        }
        const trial: Trial = {
            callers: [wanted],
            result: queue.then(() => {
                const needed = trial.callers?.some((caller) => caller())
                trial.callers = undefined
                if (needed) return run(config)
                trials.delete(key)
                throw new Superseded()
            }),
        }
        queue = trial.result.catch(() => undefined)
        trials.set(key, trial)
        return trial.result
    }
    const resolveFormat = async (
        s: CodecSettings,
        format: VideoFormat,
        trial: boolean,
        wanted: () => boolean,
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
            if (
                (await probe('video', video, probes.video)) &&
                (!trial || (await passesTrial(video, wanted)))
            )
                return { supported: true, format, video, audio }
        }
        return { supported: false, reason: 'videoConfig' }
    }
    /** Rejects with `Superseded` when a trial it needs is skipped. */
    const resolve = async (
        s: CodecSettings,
        { trial = true, wanted = () => true }: ResolveOptions = {},
    ): Promise<CodecSupport> => {
        if (s.format !== 'automatic') return resolveFormat(s, s.format, trial, wanted)
        const mp4 = await resolveFormat(s, 'mp4', trial, wanted)
        return mp4.supported ? mp4 : resolveFormat(s, 'webm', trial, wanted)
    }
    return { resolve }
}

/** Each update resolves the selection, then all offered choices. A late result changes nothing. */
export const createCodecAvailability = (probes: ReturnType<typeof createCodecProbes>) => {
    type State = { pending: boolean; current?: CodecSupport; choices: Record<string, CodecSupport> }
    let state: State = { pending: true, choices: {} }
    let shownChoices: State['choices'] = {}
    let revision = 0
    return {
        get state() {
            return state
        },
        /** `changed` receives the selection, then the choices, while the update is the latest. */
        async update(
            settings: CodecSettings,
            choices: Record<string, Partial<CodecSettings>>,
            changed: (state: State) => void = () => undefined,
        ) {
            const currentRevision = ++revision
            const wanted = () => currentRevision === revision
            const publish = (next: State) => {
                if (!wanted()) return
                state = next
                changed(next)
            }
            state = { pending: true, choices: {} }
            try {
                // The selection first, so that Export waits only for its own probes and trials.
                const current = await probes.resolve({ ...settings }, { wanted })
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
                        return [key, await probes.resolve(choice, { trial, wanted })] as const
                    }),
                )
                if (wanted()) shownChoices = Object.fromEntries(resolved)
                publish({ pending: false, current, choices: shownChoices })
            } catch (error) {
                if (!(error instanceof Superseded)) throw error
            }
            return state
        },
    }
}

export const outputSize = (height: number, aspect: number) => ({
    width: 2 * Math.round((height * aspect) / 2),
    height,
})
