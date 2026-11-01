import { configurationKey } from '../codecs'
import {
    AUDIO_CHANNELS,
    AUDIO_PAD,
    AUDIO_RATE,
    AUDIO_UNIT,
    sampleTimestamp,
    type AudioBlock,
} from '../timing'

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

const bytesOf = (buffer: AllowSharedBufferSource) =>
    ArrayBuffer.isView(buffer)
        ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
        : new Uint8Array(buffer)

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

export const audioAccounting = (
    delay: number,
    samples: number,
    encodedSamples: number,
): AudioAccounting => {
    const timing = audioTiming(delay, samples)
    if (!Number.isSafeInteger(encodedSamples) || encodedSamples < timing.endSample)
        throw new Error('Invalid encoded audio length')
    return { ...timing, paddingSamples: encodedSamples - timing.endSample }
}

export const aacPacketBound = (samples: number, delayAllowance: number) =>
    Math.ceil((samples + AUDIO_PAD) / 1024) + delayAllowance

const packetOf = (chunk: EncodedAudioChunk | EncodedVideoChunk, shift = 0): EncodedPacket => {
    if (chunk.duration === null) throw new Error('Encoder omitted packet duration')
    const data = new Uint8Array(chunk.byteLength)
    chunk.copyTo(data)
    return { data, type: chunk.type, timestamp: chunk.timestamp - shift, duration: chunk.duration }
}

export const videoPacket = (
    chunk: EncodedVideoChunk,
    metadata?: EncodedVideoChunkMetadata,
): MuxInput => ({
    track: 'video',
    packet: packetOf(chunk),
    decoderConfig: metadata?.decoderConfig,
})

export const createAudioPacketAdapter = (options: {
    codec: 'aac' | 'opus'
    samples: number
    aacDelay?: number
    emit: (input: MuxInput) => void
}) => {
    let firstTimestamp: number | undefined
    let delay = options.codec === 'aac' ? options.aacDelay : undefined
    let encodedEnd = 0
    let configured = false
    let ended = false
    return {
        output(chunk: EncodedAudioChunk, metadata?: EncodedAudioChunkMetadata) {
            if (ended) throw new Error('Audio adapter is closed')
            let config = metadata?.decoderConfig
            if (config) {
                if (!config.description) throw new Error('Encoder omitted audio configuration')
                if (options.codec === 'aac')
                    config = { ...config, description: normalizeAacDescription(config.description) }
                else {
                    const reported = opusPreSkip(config.description)
                    if (delay !== undefined && delay !== reported)
                        throw new Error('Opus delay changed')
                    delay = reported
                    const description = new Uint8Array(bytesOf(config.description))
                    const trim = delay + AUDIO_PAD
                    if (trim > 65535) throw new Error('Opus delay exceeds pre-skip field')
                    description[10] = trim & 255
                    description[11] = trim >> 8
                    config = { ...config, description }
                }
                configured = true
            }
            if (!configured || delay === undefined) throw new Error('Audio timing is unknown')
            const timing =
                firstTimestamp === undefined ? audioTiming(delay, options.samples) : undefined
            firstTimestamp ??= chunk.timestamp
            const packet = packetOf(chunk, firstTimestamp)
            if (packet.timestamp < 0) throw new Error('Audio packets are out of order')
            encodedEnd = Math.max(encodedEnd, packet.timestamp + packet.duration)
            packet.timestamp -= ((AUDIO_PAD + delay) * 1e6) / AUDIO_RATE
            options.emit({ track: 'audio', packet, decoderConfig: config, timing })
        },
        finish() {
            if (ended || firstTimestamp === undefined || delay === undefined)
                throw new Error('Audio output is incomplete')
            const trim = audioAccounting(
                delay,
                options.samples,
                Math.round((encodedEnd * AUDIO_RATE) / 1e6),
            )
            options.emit({ track: 'audioEnd', paddingSamples: trim.paddingSamples })
            ended = true
            return trim
        },
    }
}

/** One call submits at most 100 ms. The caller waits for room before every call, including the pad. */
export const createAudioFeeder = (
    encoder: Pick<AudioEncoder, 'encode'>,
    samples: number,
    makeData = (init: AudioDataInit) => new AudioData(init),
) => {
    let nextSample = -AUDIO_PAD
    const submit = (start: number, planes: AudioBlock['planes']) => {
        const length = planes[0].length
        const data = new Float32Array(length * AUDIO_CHANNELS)
        data.set(planes[0])
        data.set(planes[1], length)
        const audio = makeData({
            format: 'f32-planar',
            sampleRate: AUDIO_RATE,
            numberOfChannels: AUDIO_CHANNELS,
            numberOfFrames: length,
            timestamp: sampleTimestamp(start),
            data,
        })
        try {
            encoder.encode(audio)
        } finally {
            audio.close()
        }
        nextSample += length
    }
    return {
        pad() {
            if (nextSample !== -AUDIO_PAD) throw new Error('Audio lead-in was already submitted')
            submit(-AUDIO_PAD, [new Float32Array(AUDIO_PAD), new Float32Array(AUDIO_PAD)])
        },
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
            submit(unit.startSample, unit.planes)
        },
        finish() {
            if (nextSample !== samples) throw new Error('Audio input is incomplete')
        },
        get submittedEnd() {
            return Math.max(0, nextSample) / AUDIO_RATE
        },
    }
}

/** Cache belongs to the page's job owner, as do the encoder probes. */
export const createAacCalibration = (measure = measureAacDelay) => {
    const cache = new Map<string, Promise<number>>()
    return (config: AudioEncoderConfig) => {
        const key = configurationKey(config)
        let result = cache.get(key)
        if (!result) {
            result = measure(config).catch((error: unknown) => {
                cache.delete(key)
                throw error
            })
            cache.set(key, result)
        }
        return result
    }
}

export const measureAacDelay = async (config: AudioEncoderConfig): Promise<number> => {
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
    try {
        encoder.configure(config)
        const feeder = createAudioFeeder(encoder, AUDIO_UNIT)
        feeder.pad()
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
        return delay
    } finally {
        if (encoder.state !== 'closed') encoder.close()
        if (decoder.state !== 'closed') decoder.close()
    }
}
