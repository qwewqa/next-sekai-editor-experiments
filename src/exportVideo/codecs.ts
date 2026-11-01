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

export type EncoderProbes = {
    video?: (config: VideoEncoderConfig) => Promise<{ supported?: boolean }>
    audio?: (config: AudioEncoderConfig) => Promise<{ supported?: boolean }>
}

export const browserEncoderProbes = (): EncoderProbes => ({
    video:
        typeof VideoEncoder === 'undefined' ? undefined : (c) => VideoEncoder.isConfigSupported(c),
    audio:
        typeof AudioEncoder === 'undefined' ? undefined : (c) => AudioEncoder.isConfigSupported(c),
})

/** The page owner keeps this instance for both settings and export jobs. */
export const createCodecProbes = (probes: EncoderProbes = browserEncoderProbes()) => {
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
    const resolveFormat = async (s: CodecSettings, format: VideoFormat): Promise<CodecSupport> => {
        if (!probes.video) return { supported: false, reason: 'videoEncoder' }
        const common: Omit<VideoEncoderConfig, 'codec'> = {
            width: s.width,
            height: s.height,
            framerate: s.frameRate,
            bitrate: s.videoBitrate,
            bitrateMode: 'variable',
            latencyMode: 'quality',
            hardwareAcceleration: 'no-preference',
        }
        const configs: VideoEncoderConfig[] = []
        if (format === 'mp4') {
            for (const [profile, id] of [
                ['high', '64'],
                ['main', '4d'],
                ['baseline', '42'],
            ] as const) {
                const level = h264Level(s, profile)
                if (level !== undefined)
                    configs.push({
                        ...common,
                        codec: `avc1.${id}00${level.toString(16).padStart(2, '0')}`,
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
        let video: VideoEncoderConfig | undefined
        for (const config of configs) {
            if (await probe('video', config, probes.video)) {
                video = config
                break
            }
        }
        if (!video) return { supported: false, reason: 'videoConfig' }
        if (!s.bgm && !s.sfx) return { supported: true, format, video }
        if (!probes.audio) return { supported: false, reason: 'audioEncoder' }
        const audio: AudioEncoderConfig = {
            codec: format === 'mp4' ? 'mp4a.40.2' : 'opus',
            sampleRate: 48000,
            numberOfChannels: 2,
            bitrate: s.audioBitrate,
            bitrateMode: 'variable',
        }
        if (!(await probe('audio', audio, probes.audio)))
            return { supported: false, reason: 'audioConfig' }
        return { supported: true, format, video, audio }
    }
    const resolve = async (s: CodecSettings): Promise<CodecSupport> => {
        if (s.format !== 'automatic') return resolveFormat(s, s.format)
        const mp4 = await resolveFormat(s, 'mp4')
        return mp4.supported ? mp4 : resolveFormat(s, 'webm')
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
            const [current, resolved] = await Promise.all([
                probes.resolve({ ...settings }),
                Promise.all(
                    Object.entries(choices).map(
                        async ([key, patch]) =>
                            [key, await probes.resolve({ ...settings, ...patch })] as const,
                    ),
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
