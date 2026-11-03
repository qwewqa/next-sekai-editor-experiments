import { configurationKey, createSharedWork } from '../codecs'
import { exportError } from '../error'
import {
    AUDIO_CHANNELS,
    AUDIO_PAD,
    AUDIO_RATE,
    AUDIO_UNIT,
    frameTimestamp,
    sampleTimestamp,
    type AudioBlock,
} from '../timing'
import type { ExportWarning } from '../warnings'
import { withAvcColor, type MeasuredColor } from './avcColor'
import { bitReader, bytesOf, toBits } from './bitstream'
import { readAvcRecord, vp9FrameSize } from './videoInit'
import { createVp9Color } from './vp9Color'

export type EncodedPacket = {
    type: EncodedAudioChunkType
    timestamp: number
    duration: number
    data: Uint8Array<ArrayBuffer>
}
export type AudioTiming = {
    sampleRate: number
    startSamples: number
    playableSamples: number
    endSample: number
}
/** Packet callbacks are synchronous. The frame loop owns their queue and drains it to the muxer. */
export type MuxInput =
    | { track: 'video'; packet: EncodedPacket; decoderConfig?: VideoDecoderConfig }
    | {
          track: 'audio'
          packet: EncodedPacket
          decoderConfig?: AudioDecoderConfig
          timing?: AudioTiming
      }
    | { track: 'audioEnd'; paddingSamples: number }

/** AAC-LC at 48 kHz in stereo with 1,024-sample frames: the configuration the export requests. */
const AAC_REQUESTED = [0x11, 0x90]

/** The AudioSpecificConfig of a description: the bytes, or the one inside an ES_Descriptor. */
const readAacDescriptor = (bytes: Uint8Array): Uint8Array<ArrayBuffer> | undefined => {
    if (bytes[0] !== 3) return new Uint8Array(bytes)
    const byteAt = (at: number) => {
        const value = bytes[at]
        if (value === undefined) throw new Error('Invalid AAC descriptor')
        return value
    }
    // ES_Descriptor and DecoderConfigDescriptor have headers before their nested descriptors.
    const read = (start: number, limit: number): Uint8Array<ArrayBuffer> | undefined => {
        let at = start
        while (at < limit) {
            const tag = bytes[at++]
            let size = 0
            let complete = false
            for (let i = 0; i < 4 && at < limit; i++) {
                const value = byteAt(at++)
                size = size * 128 + (value & 127)
                if (!(value & 128)) {
                    complete = true
                    break
                }
            }
            const end = at + size
            if (!complete || end > limit) throw new Error('Invalid AAC descriptor')
            if (tag === 5) return new Uint8Array(bytes.subarray(at, end))
            let child = at
            if (tag === 3) {
                if (size < 3) throw new Error('Invalid AAC ES descriptor')
                const flags = byteAt(at + 2)
                child += 3
                if (flags & 128) child += 2
                if (flags & 64) {
                    if (child >= end) throw new Error('Invalid AAC URL')
                    child += 1 + byteAt(child)
                }
                if (flags & 32) child += 2
            } else if (tag === 4) child += 13
            if (tag === 3 || tag === 4) {
                if (child > end) throw new Error('Invalid AAC descriptor header')
                const found = read(child, end)
                if (found) return found
            }
            at = end
        }
    }
    return read(0, bytes.length)
}

/**
 * The AudioSpecificConfig the muxer receives. A missing, truncated or malformed description, or
 * one with object type 0, is replaced by the requested configuration.
 */
export const normalizeAacDescription = (
    description?: AllowSharedBufferSource,
): Uint8Array<ArrayBuffer> => {
    try {
        const asc = description && readAacDescriptor(bytesOf(description))
        if (asc && asc.length >= 2 && (asc[0] ?? 0) >> 3) return asc
    } catch {
        // A malformed description gets the requested configuration below.
    }
    return new Uint8Array(AAC_REQUESTED)
}

/** Object types whose AudioSpecificConfig has a GASpecificConfig, with its frame length flag. */
const GA_TYPES = [1, 2, 3, 4, 6, 7, 17, 19, 20, 21, 22, 23]

/** Samples per AAC frame in an AudioSpecificConfig: 960 or 1,024. Undefined when unknown. */
export const aacFrameLength = (asc: Uint8Array): number | undefined => {
    try {
        const r = bitReader(toBits(asc))
        let type = r.read(5)
        if (type === 31) type = 32 + r.read(6)
        if (r.read(4) === 15) r.read(24)
        r.read(4) // channelConfiguration
        return GA_TYPES.includes(type) ? (r.read() ? 960 : 1024) : undefined
    } catch {
        return undefined
    }
}

/** Samples at 48 kHz in an Opus packet, from its TOC byte and frame count (RFC 6716, 3.1). */
export const opusPacketSamples = (data: Uint8Array): number | undefined => {
    const toc = data[0]
    if (toc === undefined) return undefined
    const config = toc >> 3
    const frame =
        config < 12
            ? [480, 960, 1920, 2880][config % 4]
            : config < 16
              ? [480, 960][config % 2]
              : [120, 240, 480, 960][config % 4]
    const code = toc & 3
    const count = code === 0 ? 1 : code < 3 ? 2 : (data[1] ?? 0) & 63
    return frame && count ? frame * count : undefined
}

export const opusPreSkip = (description: AllowSharedBufferSource) => {
    const bytes = bytesOf(description)
    if (bytes.length < 19 || String.fromCharCode(...bytes.subarray(0, 8)) !== 'OpusHead')
        throw new Error('Invalid Opus header')
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(10, true)
}

const audioTiming = (delay: number, samples: number): AudioTiming => {
    const startSamples = AUDIO_PAD + delay
    const endSample = startSamples + samples
    if (![delay, samples].every(Number.isSafeInteger) || delay < 0 || samples <= 0)
        throw new Error('Invalid encoded audio length')
    return {
        sampleRate: AUDIO_RATE,
        startSamples,
        playableSamples: samples,
        endSample,
    }
}

/** Samples, 2 ms, that the sound may end short by without a warning: an error in the delay. */
export const AUDIO_SHORTFALL = 96

/**
 * The AAC delay in samples when it cannot be measured: one frame, as common encoders have.
 * Sound placed with it has the `audioSyncEstimated` warning.
 */
export const AAC_DELAY_ESTIMATE = 1024

/**
 * The MP4 reservation for AAC: the lead-in, the delay, the clip and the tail in 512-sample
 * packets, half the shorter frame, and 64 more. Packets after the clip are left out.
 */
export const aacPacketBound = (samples: number, delay: number) =>
    Math.ceil((samples + AUDIO_PAD + delay + AAC_TAIL) / 512) + 64

/** The MP4 reservation for video: the frames, and room for extra encoder output. */
export const videoPacketBound = (frames: number) => frames + Math.max(120, Math.ceil(frames / 10))

/** A copy of a chunk's bytes, with its type. */
const packetOf = (chunk: EncodedAudioChunk | EncodedVideoChunk) => {
    const data = new Uint8Array(chunk.byteLength)
    chunk.copyTo(data)
    return { data, type: chunk.type }
}

const sameBytes = (a: AllowSharedBufferSource, b: AllowSharedBufferSource) => {
    const x = bytesOf(a)
    const y = bytesOf(b)
    return x.length === y.length && x.every((value, i) => value === y[i])
}

/** Colour for one video track, from the measured conversion when there is one. */
export const createVideoColor = (measured?: MeasuredColor) => {
    const vp9 = createVp9Color(measured)
    let avc = false
    return (packet: EncodedPacket, config?: VideoDecoderConfig) => {
        if (config) avc = /^avc[13]\./.test(config.codec)
        if (!avc) return vp9(packet.data, packet.type, config)
        return config && withAvcColor(config, measured)
    }
}

/**
 * Places encoded audio end to end by packet durations; a missing duration is read from the
 * codec. Any failure throws, and the caller ends the export with an `AudioFailure`.
 */
export const createAudioPacketAdapter = (options: {
    codec: 'aac' | 'opus'
    samples: number
    /** The measured AAC delay. Without it, `AAC_DELAY_ESTIMATE` places the sound. */
    aacDelay?: number
    emit: (input: MuxInput) => void
}) => {
    const aac = options.codec === 'aac'
    let delay = aac ? (options.aacDelay ?? AAC_DELAY_ESTIMATE) : undefined
    const bound = delay === undefined ? Infinity : aacPacketBound(options.samples, delay)
    /** The ends of the encoded output and of the output the muxer received, in samples. */
    let encodedSamples = 0
    let written = 0
    let packets = 0
    let reportedFirst: AudioDecoderConfig | undefined
    let pending: AudioDecoderConfig | undefined
    let frameLength: number | undefined
    let ended = false
    /** The first configuration, as the muxer receives it. */
    const configure = (reported?: AudioDecoderConfig): AudioDecoderConfig => {
        if (aac) {
            const description = normalizeAacDescription(reported?.description)
            frameLength = aacFrameLength(description)
            return {
                codec: 'mp4a.40.2',
                sampleRate: AUDIO_RATE,
                numberOfChannels: AUDIO_CHANNELS,
                ...reported,
                description,
            }
        }
        if (!reported?.description) throw new Error('Encoder omitted the Opus header')
        delay = opusPreSkip(reported.description)
        const description = new Uint8Array(bytesOf(reported.description))
        const trim = delay + AUDIO_PAD
        if (trim > 65535) throw new Error('Opus delay exceeds pre-skip field')
        description[10] = trim & 255
        description[11] = trim >> 8
        return { ...reported, description }
    }
    /** A repeated configuration may differ in its wrapper or leave out its description. */
    const same = (reported: AudioDecoderConfig, known: AudioDecoderConfig) =>
        reported.sampleRate === known.sampleRate &&
        reported.numberOfChannels === known.numberOfChannels &&
        (!reported.description ||
            !known.description ||
            (aac
                ? sameBytes(
                      normalizeAacDescription(reported.description),
                      normalizeAacDescription(known.description),
                  )
                : sameBytes(reported.description, known.description)))
    const durationOf = (chunk: EncodedAudioChunk, data: Uint8Array) => {
        const reported = Math.round(((chunk.duration ?? 0) * AUDIO_RATE) / 1e6)
        if (reported > 0) return reported
        const recovered = aac ? frameLength : opusPacketSamples(data)
        if (!recovered) throw new Error('Audio packet duration is unknown')
        return recovered
    }
    return {
        output(chunk: EncodedAudioChunk, metadata?: EncodedAudioChunkMetadata) {
            if (ended) throw new Error('Audio adapter is closed')
            const reported = metadata?.decoderConfig
            if (!reportedFirst) {
                if (!reported && !aac) throw new Error('Encoder omitted audio configuration')
                pending = configure(reported)
                reportedFirst = reported ?? pending
            } else if (reported && !same(reported, reportedFirst))
                throw new Error('Audio configuration changed')
            if (delay === undefined) throw new Error('Audio timing is unknown')
            const { data, type } = packetOf(chunk)
            const start = encodedSamples
            // Packets are placed end to end by their durations. Firefox's Opus timestamps after
            // the first packet are early by the pre-skip.
            encodedSamples += durationOf(chunk, data)
            // AAC ends at the clip's end. Later packets are left out, and the one that crosses it
            // is shortened.
            const end = aac
                ? Math.min(encodedSamples, AUDIO_PAD + delay + options.samples)
                : encodedSamples
            // A packet past the MP4 reservation ends the sound before it.
            if (end <= start || packets >= bound) return
            const packet: EncodedPacket = {
                type,
                data,
                timestamp: ((start - AUDIO_PAD - delay) * 1e6) / AUDIO_RATE,
                duration: ((end - start) * 1e6) / AUDIO_RATE,
            }
            const timing = packets === 0 ? audioTiming(delay, options.samples) : undefined
            options.emit({ track: 'audio', packet, decoderConfig: pending, timing })
            pending = undefined
            packets++
            written = end
        },
        finish() {
            if (ended) throw new Error('Audio adapter is closed')
            if (!packets || delay === undefined) throw new Error('No audio was encoded')
            ended = true
            const timing = audioTiming(delay, options.samples)
            const paddingSamples = aac ? 0 : Math.max(0, written - timing.endSample)
            options.emit({ track: 'audioEnd', paddingSamples })
            const warnings: ExportWarning[] = []
            if (written < timing.endSample - AUDIO_SHORTFALL)
                warnings.push({
                    code: 'soundStopped',
                    at: Math.max(0, written - timing.startSamples) / AUDIO_RATE,
                })
            if (aac && options.aacDelay === undefined) warnings.push({ code: 'audioSyncEstimated' })
            return { ...timing, paddingSamples, warnings }
        },
    }
}

type VideoColorStep = ReturnType<typeof createVideoColor>
type VideoSize = { width: number; height: number }
type VideoInit = { codec: string; size: VideoSize | undefined; essential?: string }

/**
 * The codec string and displayed size of a configuration, and for H.264 its colour-free
 * initialization, from the bitstream where it can be read. Undefined for H.264 without a usable
 * record; see `readAvcRecord`.
 */
const readInit = (config: VideoDecoderConfig, data: Uint8Array): VideoInit | undefined => {
    if (/^avc[13]\./.test(config.codec))
        return config.description ? readAvcRecord(config.description) : undefined
    const reported: VideoSize | undefined =
        config.codedWidth !== undefined && config.codedHeight !== undefined
            ? { width: config.codedWidth, height: config.codedHeight }
            : undefined
    return {
        codec: config.codec,
        size: (config.codec.startsWith('vp09') ? vp9FrameSize(data) : undefined) ?? reported,
    }
}

/**
 * Places each packet on a whole frame and gives it that frame's timing; packets keep their
 * encoded order. A timestamp rounds to its nearest frame, which absorbs WebKit's timestamps
 * that are 1 µs early (https://webkit.org/b/321880). A frame that is out of the clip, taken, or
 * not after the packet's group gets the frame after the latest one instead, with a warning.
 * Video starts at the first key packet with a usable configuration. A later H.264
 * configuration that differs in more than colour, a size change, too many packets or `end()`
 * ends the track there.
 */
export const createVideoPacketAdapter = (options: {
    /** The requested codec, for VP9 output without a configuration. */
    codec: string
    width: number
    height: number
    frames: number
    frameRate: 30 | 60
    /** One track's colour step. Every packet passes through it in encoded order. */
    color: VideoColorStep
    emit: (input: MuxInput) => void
}) => {
    const { frameRate, color, frames } = options
    const bound = videoPacketBound(frames)
    const used = new Uint8Array(frames)
    let maxIndex = -1
    let groupFloor = -1
    let placed = 0
    let retimed = 0
    let skipped = false
    let first: (VideoInit & { size: VideoSize }) | undefined
    let waiting: VideoDecoderConfig | undefined
    let stopped = false
    let failure: unknown
    const end = (error?: unknown) => {
        stopped = true
        failure ??= error
    }
    return {
        get ended() {
            return stopped
        },
        /** Ends the track before the next packet. `error` is the failure if no video was kept. */
        end,
        output(chunk: EncodedVideoChunk, metadata?: EncodedVideoChunkMetadata) {
            if (stopped) return
            const reported = metadata?.decoderConfig
            const { data, type } = packetOf(chunk)
            let config: VideoDecoderConfig | undefined
            if (!first) {
                if (reported) waiting = reported
                const known = waiting ?? {
                    codec: options.codec,
                    codedWidth: options.width,
                    codedHeight: options.height,
                }
                const init = type === 'key' ? readInit(known, data) : undefined
                if (!init) {
                    skipped = true
                    return
                }
                const size = init.size ?? { width: options.width, height: options.height }
                first = { ...init, size }
                config = {
                    ...known,
                    codec: init.codec,
                    codedWidth: size.width,
                    codedHeight: size.height,
                    displayAspectWidth: undefined,
                    displayAspectHeight: undefined,
                }
            } else if (reported) {
                const found = readInit(reported, data)
                const size = found?.size
                if (
                    !found ||
                    (first.codec.startsWith('avc') &&
                        (found.codec !== first.codec || found.essential !== first.essential)) ||
                    (size && (size.width !== first.size.width || size.height !== first.size.height))
                ) {
                    end(new Error('Video configuration changed'))
                    return
                }
                config = reported
            }
            if (placed >= bound) {
                end(new Error('Too many video packets'))
                return
            }
            const key = type === 'key'
            const proposed = Number.isSafeInteger(chunk.timestamp)
                ? Math.round((chunk.timestamp * frameRate) / 1e6)
                : -1
            let index: number
            if (maxIndex < 0) {
                index = 0
                if (proposed !== 0 || skipped) retimed++
            } else {
                const floor = key ? maxIndex : groupFloor
                if (proposed > floor && proposed < frames && !used[proposed]) index = proposed
                else {
                    index = maxIndex + 1
                    retimed++
                }
            }
            if (key) groupFloor = maxIndex
            if (index < frames) used[index] = 1
            maxIndex = Math.max(maxIndex, index)
            const at = frameTimestamp(index, frameRate)
            const packet: EncodedPacket = {
                type,
                data,
                timestamp: at,
                duration: frameTimestamp(index + 1, frameRate) - at,
            }
            const colored = color(packet, config)
            options.emit({ track: 'video', packet, decoderConfig: placed ? undefined : colored })
            placed++
        },
        /** The warnings about the video. Throws when no video was kept. */
        finish(): ExportWarning[] {
            if (!placed || !first) throw exportError(failure ?? 'No usable video was encoded')
            const warnings: ExportWarning[] = []
            const { width, height } = first.size
            if (width !== options.width || height !== options.height)
                warnings.push({ code: 'resolutionDiffers', width, height })
            const until = stopped ? Math.min(frames, maxIndex + 1) : frames
            let missing = 0
            for (let i = 0; i < until; i++) if (!used[i]) missing++
            if (missing) warnings.push({ code: 'framesMissing', count: missing })
            if (retimed) warnings.push({ code: 'timingReassigned', count: retimed })
            if (until < frames)
                warnings.push({
                    code: 'pictureStopped',
                    at: frameTimestamp(until, frameRate) / 1e6,
                })
            return warnings
        },
    }
}

/**
 * Silent samples after AAC input, one frame. Chromium on Android drops the last packet. With the
 * tail, that packet contains only silence.
 */
export const AAC_TAIL = 1024

/**
 * One call submits at most 100 ms of clip audio. The first also carries the silent lead-in and,
 * for AAC, the last carries the silent tail. The caller waits for room before every call.
 */
export const createAudioFeeder = (
    encoder: Pick<AudioEncoder, 'encode'>,
    samples: number,
    codec: 'aac' | 'opus',
    makeData = (init: AudioDataInit) => new AudioData(init),
) => {
    let nextSample = 0
    return {
        feed(unit: AudioBlock) {
            const length = unit.planes[0].length
            if (
                unit.startSample !== nextSample ||
                length <= 0 ||
                length > AUDIO_UNIT ||
                unit.planes[1].length !== length ||
                nextSample + length > samples
            )
                throw new Error('Unexpected audio unit')
            const before = nextSample === 0 ? AUDIO_PAD : 0
            const after = codec === 'aac' && nextSample + length === samples ? AAC_TAIL : 0
            const frames = before + length + after
            const data = new Float32Array(frames * AUDIO_CHANNELS)
            data.set(unit.planes[0], before)
            data.set(unit.planes[1], frames + before)
            const audio = makeData({
                format: 'f32-planar',
                sampleRate: AUDIO_RATE,
                numberOfChannels: AUDIO_CHANNELS,
                numberOfFrames: frames,
                timestamp: sampleTimestamp(unit.startSample - before),
                data,
            })
            try {
                encoder.encode(audio)
            } finally {
                audio.close()
            }
            nextSample += length
        },
        finish() {
            if (nextSample !== samples) throw new Error('Audio input is incomplete')
        },
    }
}

export const createAacCalibration = (measure = measureAacDelay) => {
    const shared = createSharedWork<number>()
    return (config: AudioEncoderConfig, signal?: AbortSignal) =>
        shared(configurationKey(config), (stop) => measure(config, stop), signal)
}

/** Closing the codecs on `signal` ends their pending flushes. */
export const measureAacDelay = async (
    config: AudioEncoderConfig,
    signal?: AbortSignal,
): Promise<number> => {
    if (
        config.codec !== 'mp4a.40.2' ||
        config.sampleRate !== AUDIO_RATE ||
        config.numberOfChannels !== AUDIO_CHANNELS
    )
        throw new Error('Unsupported AAC calibration configuration')
    const chunks: EncodedAudioChunk[] = []
    let decoderConfig: AudioDecoderConfig | undefined
    let failure: DOMException | undefined
    const checkFailure = () => {
        if (failure) throw failure
    }
    let decodedSamples = 0
    let peak = 0
    let peakSample = -1
    const decoder = new AudioDecoder({
        error: (error) => {
            failure = error
        },
        output: (audio) => {
            try {
                const plane = new Float32Array(audio.numberOfFrames)
                audio.copyTo(plane, { planeIndex: 0, format: 'f32-planar' })
                for (const [i, sample] of plane.entries()) {
                    if (Math.abs(sample) > peak) {
                        peak = Math.abs(sample)
                        peakSample = decodedSamples + i
                    }
                }
                decodedSamples += audio.numberOfFrames
            } finally {
                audio.close()
            }
        },
    })
    const encoder = new AudioEncoder({
        error: (error) => {
            failure = error
        },
        output: (chunk, metadata) => {
            chunks.push(chunk)
            if (metadata?.decoderConfig) decoderConfig = metadata.decoderConfig
        },
    })
    const close = () => {
        if (encoder.state !== 'closed') encoder.close()
        if (decoder.state !== 'closed') decoder.close()
    }
    signal?.addEventListener('abort', close, { once: true })
    try {
        signal?.throwIfAborted()
        encoder.configure(config)
        const feeder = createAudioFeeder(encoder, AUDIO_UNIT, 'aac')
        const impulse = AUDIO_UNIT / 2
        const plane = new Float32Array(AUDIO_UNIT)
        plane[impulse] = 1
        feeder.feed({ startSample: 0, planes: [plane, plane] })
        feeder.finish()
        await encoder.flush()
        checkFailure()
        decoder.configure({
            codec: 'mp4a.40.2',
            sampleRate: AUDIO_RATE,
            numberOfChannels: AUDIO_CHANNELS,
            ...decoderConfig,
            description: normalizeAacDescription(decoderConfig?.description),
        })
        for (const chunk of chunks) decoder.decode(chunk)
        await decoder.flush()
        checkFailure()
        const delay = peakSample - AUDIO_PAD - impulse
        if (peak < 0.01 || delay < 0) throw new Error('AAC delay could not be measured')
        return delay
    } catch (error) {
        signal?.throwIfAborted()
        throw error
    } finally {
        signal?.removeEventListener('abort', close)
        close()
    }
}
