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
    let failure: DOMException | undefined
    const encoder = new VideoEncoder({
        output: (chunk, metadata) => {
            const { type, timestamp, duration } = chunk
            chunks.push({ type, timestamp, duration, decoderConfig: metadata?.decoderConfig })
        },
        error: (error) => {
            failure = error
        },
    })
    try {
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
    } catch (error) {
        const reason = failure ?? error
        if (reason instanceof DOMException && reason.name === 'EncodingError') return false
        throw reason
    } finally {
        if (encoder.state !== 'closed') encoder.close()
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
    // Trials run one at a time, since each holds an encoder and full-size frames.
    let lastTrial: Promise<unknown> = Promise.resolve()
    const passesTrial = (config: TrialConfig) => {
        const run = probes.trial
        if (!run) return true
        return probe('trial', config, (c) => {
            const result = lastTrial.then(() => run(c))
            lastTrial = result.catch(() => undefined)
            return result.then((supported) => ({ supported }))
        })
    }
    const resolveFormat = async (
        s: CodecSettings,
        format: VideoFormat,
        trial: boolean,
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
                (!trial || (await passesTrial(video)))
            )
                return { supported: true, format, video, audio }
        }
        return { supported: false, reason: 'videoConfig' }
    }
    /** With `trial` false, isConfigSupported alone decides. */
    const resolve = async (s: CodecSettings, trial = true): Promise<CodecSupport> => {
        if (s.format !== 'automatic') return resolveFormat(s, s.format, trial)
        const mp4 = await resolveFormat(s, 'mp4', trial)
        return mp4.supported ? mp4 : resolveFormat(s, 'webm', trial)
    }
    return { resolve }
}

/** Each update resolves all offered choices. A late result cannot enable an obsolete selection. */
export const createCodecAvailability = (probes: ReturnType<typeof createCodecProbes>) => {
    type State = { pending: boolean; current?: CodecSupport; choices: Record<string, CodecSupport> }
    let state: State = { pending: true, choices: {} }
    let revision = 0
    return {
        get state() {
            return state
        },
        async update(settings: CodecSettings, choices: Record<string, Partial<CodecSettings>>) {
            const currentRevision = ++revision
            state = { pending: true, choices: {} }
            // Trials encode full-size frames, so choices at another size, frame rate or bitrate
            // skip them.
            const sameVideo = (choice: CodecSettings) =>
                (['width', 'height', 'frameRate', 'videoBitrate'] as const).every(
                    (key) => choice[key] === settings[key],
                )
            const [current, resolved] = await Promise.all([
                probes.resolve({ ...settings }),
                Promise.all(
                    Object.entries(choices).map(async ([key, patch]) => {
                        const choice = { ...settings, ...patch }
                        return [key, await probes.resolve(choice, sameVideo(choice))] as const
                    }),
                ),
            ])
            if (currentRevision === revision)
                state = { pending: false, current, choices: Object.fromEntries(resolved) }
            return state
        },
    }
}

export const outputSize = (height: number, aspect: number) => ({
    width: 2 * Math.round((height * aspect) / 2),
    height,
})
