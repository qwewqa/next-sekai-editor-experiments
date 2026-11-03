import { configurationKey, createSharedWork } from '../codecs'
import {
    AUDIO_CHANNELS,
    AUDIO_PAD,
    AUDIO_RATE,
    AUDIO_UNIT,
    frameTimestamp,
    sampleTimestamp,
    type AudioBlock,
} from '../timing'
import { withAvcColor, type MeasuredColor } from './avcColor'
import { bytesOf } from './bitstream'
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
export type AudioAccounting = AudioTiming & { paddingSamples: number }
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

/** ES_Descriptor and DecoderConfigDescriptor have headers before their nested descriptors. */
export const normalizeAacDescription = (
    description: AllowSharedBufferSource,
): Uint8Array<ArrayBuffer> => {
    const bytes = bytesOf(description)
    if (bytes[0] !== 3) return new Uint8Array(bytes)
    const byteAt = (at: number) => {
        const value = bytes[at]
        if (value === undefined) throw new Error('Invalid AAC descriptor')
        return value
    }
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
    const asc = read(0, bytes.length)
    if (!asc?.length) throw new Error('AAC configuration is missing')
    return asc
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

/** Samples, 2 ms, that encoded audio may end short by: an error in the measured delay. */
export const AUDIO_SHORTFALL = 96

export const audioAccounting = (
    delay: number,
    samples: number,
    encodedSamples: number,
): AudioAccounting => {
    const timing = audioTiming(delay, samples)
    if (
        !Number.isSafeInteger(encodedSamples) ||
        encodedSamples < timing.endSample - AUDIO_SHORTFALL
    )
        throw new Error('Invalid encoded audio length')
    return { ...timing, paddingSamples: Math.max(0, encodedSamples - timing.endSample) }
}

/** An encoded audio chunk's duration in whole samples. */
const chunkSamples = (chunk: EncodedAudioChunk) => {
    if (chunk.duration === null) throw new Error('Encoder omitted packet duration')
    const samples = Math.round((chunk.duration * AUDIO_RATE) / 1e6)
    if (samples <= 0) throw new Error('Invalid audio packet duration')
    return samples
}

/**
 * The MP4 reservation for AAC: the lead-in, the measured delay and the clip in the shorter of
 * the AAC-LC frame lengths, 960 and 1,024 samples. Packets after the clip are left out.
 */
export const aacPacketBound = (samples: number, delay: number) =>
    Math.ceil((samples + AUDIO_PAD + delay) / 960)

/** A video packet takes its frame's duration; audio requires one. */
const packetOf = (chunk: EncodedAudioChunk | EncodedVideoChunk): EncodedPacket => {
    const data = new Uint8Array(chunk.byteLength)
    chunk.copyTo(data)
    return {
        data,
        type: chunk.type,
        timestamp: chunk.timestamp,
        duration: chunk.duration ?? 0,
    }
}

const sameBytes = (a?: AllowSharedBufferSource, b?: AllowSharedBufferSource) => {
    if (!a || !b) return a === b
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

export const createAudioPacketAdapter = (options: {
    codec: 'aac' | 'opus'
    samples: number
    aacDelay?: number
    emit: (input: MuxInput) => void
}) => {
    let delay = options.codec === 'aac' ? options.aacDelay : undefined
    let encodedSamples = 0
    let first: AudioDecoderConfig | undefined
    let ended = false
    /** The first configuration, as the muxer receives it. */
    const configure = (reported: AudioDecoderConfig): AudioDecoderConfig => {
        if (!reported.description) throw new Error('Encoder omitted audio configuration')
        if (options.codec === 'aac') {
            return { ...reported, description: normalizeAacDescription(reported.description) }
        }
        delay = opusPreSkip(reported.description)
        const description = new Uint8Array(bytesOf(reported.description))
        const trim = delay + AUDIO_PAD
        if (trim > 65535) throw new Error('Opus delay exceeds pre-skip field')
        description[10] = trim & 255
        description[11] = trim >> 8
        return { ...reported, description }
    }
    const same = (reported: AudioDecoderConfig, known: AudioDecoderConfig) =>
        reported.codec === known.codec &&
        reported.sampleRate === known.sampleRate &&
        reported.numberOfChannels === known.numberOfChannels &&
        (options.codec === 'aac'
            ? !!reported.description &&
              !!known.description &&
              sameBytes(
                  normalizeAacDescription(reported.description),
                  normalizeAacDescription(known.description),
              )
            : sameBytes(reported.description, known.description))
    return {
        output(chunk: EncodedAudioChunk, metadata?: EncodedAudioChunkMetadata) {
            if (ended) throw new Error('Audio adapter is closed')
            const reported = metadata?.decoderConfig
            let config: AudioDecoderConfig | undefined
            if (!first) {
                if (!reported) throw new Error('Encoder omitted audio configuration')
                config = configure(reported)
                first = reported
            } else if (reported && !same(reported, first))
                throw new Error('Audio configuration changed')
            if (delay === undefined) throw new Error('Audio timing is unknown')
            const start = encodedSamples
            const timing = start === 0 ? audioTiming(delay, options.samples) : undefined
            // Packets are placed end to end by their durations. Firefox's Opus timestamps after
            // the first packet are early by the pre-skip.
            encodedSamples += chunkSamples(chunk)
            // AAC ends at the clip's end. Later packets are left out, and the one that crosses it
            // is shortened.
            const end =
                options.codec === 'aac'
                    ? Math.min(encodedSamples, AUDIO_PAD + delay + options.samples)
                    : encodedSamples
            if (end <= start) return
            const packet = packetOf(chunk)
            packet.timestamp = ((start - AUDIO_PAD - delay) * 1e6) / AUDIO_RATE
            packet.duration = ((end - start) * 1e6) / AUDIO_RATE
            options.emit({ track: 'audio', packet, decoderConfig: config, timing })
        },
        finish() {
            if (ended || encodedSamples === 0 || delay === undefined)
                throw new Error('Audio output is incomplete')
            const trim = audioAccounting(delay, options.samples, encodedSamples)
            const paddingSamples = options.codec === 'aac' ? 0 : trim.paddingSamples
            options.emit({ track: 'audioEnd', paddingSamples })
            ended = true
            return { ...trim, paddingSamples }
        },
    }
}

type VideoColorStep = ReturnType<typeof createVideoColor>

/**
 * The codec string, displayed size and colour-free initialization of a configuration, from the
 * bitstream where it can be read. An H.264 record must be readable; see `readAvcRecord`.
 */
const essentialVideo = (config: VideoDecoderConfig, packet: EncodedPacket) => {
    const reported =
        config.codedWidth !== undefined && config.codedHeight !== undefined
            ? { width: config.codedWidth, height: config.codedHeight }
            : undefined
    if (/^avc[13]\./.test(config.codec) && config.description) {
        const record = readAvcRecord(config.description)
        if (!record) throw new Error('Invalid H.264 parameter sets')
        return record
    }
    const size =
        (config.codec.startsWith('vp09') ? vp9FrameSize(packet.data) : undefined) ?? reported
    const description = config.description ? Array.from(bytesOf(config.description)).join() : ''
    return { codec: config.codec, size, essential: description }
}

/**
 * Matches each chunk to its submitted frame by presentation timestamp and takes the frame's
 * timing. Packets keep their encoded order. The first chunk carries the configuration; a later
 * one may repeat it with other colour.
 */
export const createVideoPacketAdapter = (options: {
    width: number
    height: number
    frames: number
    frameRate: 30 | 60
    /** One track's colour step. Every packet passes through it in encoded order. */
    color: VideoColorStep
    emit: (input: MuxInput) => void
}) => {
    const { frameRate, color } = options
    const seen = new Uint8Array(options.frames)
    let submitted = 0
    let emitted = 0
    let first: ReturnType<typeof essentialVideo> | undefined
    return {
        submit() {
            submitted++
        },
        output(chunk: EncodedVideoChunk, metadata?: EncodedVideoChunkMetadata) {
            const index = Math.round((chunk.timestamp * frameRate) / 1e6)
            const at = frameTimestamp(index, frameRate)
            if (index < 0 || index >= submitted || seen[index] || chunk.timestamp !== at)
                throw new Error('Missing or misplaced encoded frame')
            seen[index] = 1
            const packet = { ...packetOf(chunk), timestamp: at }
            packet.duration = frameTimestamp(index + 1, frameRate) - at
            const reported = metadata?.decoderConfig
            let decoderConfig: VideoDecoderConfig | undefined
            if (!first) {
                if (!reported) throw new Error('Encoder omitted its configuration')
                const found = essentialVideo(reported, packet)
                const { displayAspectWidth: aw, displayAspectHeight: ah } = reported
                if (
                    found.size?.width !== options.width ||
                    found.size.height !== options.height ||
                    (aw !== undefined &&
                        ah !== undefined &&
                        aw * options.height !== ah * options.width)
                )
                    throw new Error('Encoded dimensions differ from the requested size')
                first = found
                // The displayed size is established, so a padded coded size is recorded as it.
                decoderConfig = color(packet, {
                    ...reported,
                    codec: found.codec,
                    codedWidth: options.width,
                    codedHeight: options.height,
                    displayAspectWidth: undefined,
                    displayAspectHeight: undefined,
                })
            } else {
                if (reported) {
                    const found = essentialVideo(reported, packet)
                    if (
                        found.codec !== first.codec ||
                        found.essential !== first.essential ||
                        (found.size &&
                            (found.size.width !== options.width ||
                                found.size.height !== options.height))
                    )
                        throw new Error('Video configuration changed')
                }
                color(packet, reported)
            }
            emitted++
            options.emit({ track: 'video', packet, decoderConfig })
        },
        finish() {
            if (emitted !== options.frames) throw new Error('Encoded video is incomplete')
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

/** Cache belongs to the page's job owner, as do the encoder probes. */
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
        if (!decoderConfig?.description) throw new Error('AAC calibration configuration is missing')
        decoder.configure({
            ...decoderConfig,
            description: normalizeAacDescription(decoderConfig.description),
        })
        for (const chunk of chunks) decoder.decode(chunk)
        await decoder.flush()
        checkFailure()
        const delay = peakSample - AUDIO_PAD - impulse
        if (peak < 0.01 || delay < 0) throw new Error('AAC delay could not be measured')
        // Output that ends short of the input, not counting the tail, would fail an export's audio.
        audioAccounting(
            delay,
            AUDIO_UNIT,
            chunks.reduce((sum, chunk) => sum + chunkSamples(chunk), 0),
        )
        return delay
    } catch (error) {
        signal?.throwIfAborted()
        throw error
    } finally {
        signal?.removeEventListener('abort', close)
        close()
    }
}
