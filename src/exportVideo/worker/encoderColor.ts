import { exportError } from '../error'
import { frameTimestamp } from '../timing'

// An encoder can report a different RGB-to-YUV conversion from the one it applies. Firefox's
// VP9 encoder converts with BT.601 limited range and reports BT.709. The export declares the
// conversion measured here.

/** No stripe colour clips under any candidate, so the candidates decode differently. */
export const STRIPES = [
    [32, 32, 32],
    [224, 224, 224],
    [224, 32, 32],
    [32, 224, 32],
    [32, 32, 224],
    [128, 128, 128],
] as const

export const colorCandidates = [
    { matrix: 'bt709', fullRange: true },
    { matrix: 'bt709', fullRange: false },
    { matrix: 'smpte170m', fullRange: true },
    { matrix: 'smpte170m', fullRange: false },
] as const
export type ColorCandidate = (typeof colorCandidates)[number]

/** Mean difference in 8-bit levels within which decoded colours match. */
const MATCH = 2

/** The candidate whose frame decodes like the captured one, when no other comes close. */
export const chooseColor = (distances: readonly number[]): ColorCandidate | undefined => {
    if (distances.length !== colorCandidates.length) return undefined
    const best = distances.indexOf(Math.min(...distances))
    const distance = distances[best] ?? Infinity
    if (!(distance <= MATCH) || distances.some((d, i) => i !== best && !(d > distance + MATCH)))
        return undefined
    return colorCandidates[best]
}

/** Stripe edges on even columns, so no chroma sample spans two stripes. */
const stripeEdges = (width: number) =>
    Array.from({ length: STRIPES.length + 1 }, (_, i) =>
        Math.min(width, 2 * Math.round((i * width) / STRIPES.length / 2)),
    )

const toYuv = ([r, g, b]: readonly [number, number, number], candidate: ColorCandidate) => {
    const [kr, kb] = candidate.matrix === 'bt709' ? [0.2126, 0.0722] : [0.299, 0.114]
    const y = kr * r + (1 - kr - kb) * g + kb * b
    const scale = candidate.fullRange ? 1 : 224 / 255
    const level = (value: number) => Math.max(0, Math.min(255, Math.round(value)))
    return [
        level(candidate.fullRange ? y : 16 + (219 * y) / 255),
        level(128 + ((b - y) / (2 * (1 - kb))) * scale),
        level(128 + ((r - y) / (2 * (1 - kr))) * scale),
    ] as const
}

/**
 * Encodes the stripes as the export captures them, then as raw YUV frames made with each
 * candidate, and decodes all of them with one decoder. The candidate whose frame decodes like the
 * captured one is the encoder's conversion. A failure or cancellation means no measurement.
 */
export const measureEncoderColor = async (
    config: VideoEncoderConfig,
    frameRate: 30 | 60,
    capture: (edges: readonly number[]) => VideoFrame,
    signal?: AbortSignal,
): Promise<ColorCandidate | undefined> => {
    const { width, height } = config
    const edges = stripeEdges(width)
    const chunks: EncodedVideoChunk[] = []
    let decoderConfig: VideoDecoderConfig | undefined
    let failure: Error | undefined
    let stop: ((error: Error) => void) | undefined
    const fail = (error: unknown) => {
        failure ??= exportError(error)
        stop?.(failure)
    }
    const aborted = () => {
        fail(signal?.reason)
    }
    signal?.addEventListener('abort', aborted, { once: true })
    if (signal?.aborted) aborted()
    /** Waits for `operation` until a codec fails or the export is canceled. */
    const wait = <T>(operation: Promise<T>) =>
        new Promise<T>((resolve, reject) => {
            stop = reject
            operation.then(
                (value) => {
                    stop = undefined
                    if (failure) reject(failure)
                    else resolve(value)
                },
                (error: unknown) => {
                    stop = undefined
                    reject(failure ?? exportError(error))
                },
            )
            if (failure) reject(failure)
        })
    let encoder: VideoEncoder | undefined
    let decoder: VideoDecoder | undefined
    /** Each input timestamp and its frame: 0 is the captured one, then the candidates. */
    const inputs = new Map<number, number>()
    const decoded = new Map<number, number[]>()
    const spaces = new Set<string>()
    try {
        if (failure) return undefined
        const created = new VideoEncoder({
            output: (chunk, metadata) => {
                chunks.push(chunk)
                decoderConfig ??= metadata?.decoderConfig
            },
            error: fail,
        })
        encoder = created
        const encode = (frame: VideoFrame, index: number) => {
            try {
                if (inputs.has(frame.timestamp)) throw new Error('Calibration timestamps repeat')
                inputs.set(frame.timestamp, index)
                created.encode(frame, { keyFrame: true })
            } finally {
                frame.close()
            }
        }
        created.configure(config)
        encode(capture(edges), 0)
        await wait(created.flush())
        if (!decoderConfig) return undefined
        const chromaWidth = Math.ceil(width / 2)
        const lumaSize = width * height
        const chromaSize = chromaWidth * Math.ceil(height / 2)
        const data = new Uint8Array(lumaSize + 2 * chromaSize)
        const luma = new Uint8Array(width)
        const blue = new Uint8Array(chromaWidth)
        const red = new Uint8Array(chromaWidth)
        for (const [i, candidate] of colorCandidates.entries()) {
            for (const [stripe, color] of STRIPES.entries()) {
                const [y, u, v] = toYuv(color, candidate)
                const start = edges[stripe] ?? 0
                const end = edges[stripe + 1] ?? width
                luma.fill(y, start, end)
                blue.fill(u, start / 2, end / 2)
                red.fill(v, start / 2, end / 2)
            }
            for (let row = 0; row < height; row++) data.set(luma, row * width)
            for (let at = lumaSize; at < lumaSize + chromaSize; at += chromaWidth) {
                data.set(blue, at)
                data.set(red, at + chromaSize)
            }
            const timestamp = frameTimestamp(i + 1, frameRate)
            encode(
                new VideoFrame(data, {
                    format: 'I420',
                    codedWidth: width,
                    codedHeight: height,
                    timestamp,
                    duration: frameTimestamp(i + 2, frameRate) - timestamp,
                    colorSpace: decoderConfig.colorSpace ?? undefined,
                }),
                i + 1,
            )
        }
        await wait(created.flush())
        if (!(await wait(VideoDecoder.isConfigSupported(decoderConfig))).supported) return undefined
        const reader = new OffscreenCanvas(8, 8).getContext('2d', {
            willReadFrequently: true,
        })
        if (!reader) return undefined
        decoder = new VideoDecoder({
            output: (frame) => {
                try {
                    const index = inputs.get(frame.timestamp)
                    if (index === undefined || decoded.has(index))
                        throw new Error('Unexpected decoded calibration frame')
                    spaces.add(JSON.stringify(frame.colorSpace.toJSON()))
                    // The mean of an 8 by 8 block from the middle of each stripe.
                    const means = STRIPES.flatMap((_, i) => {
                        const x = Math.round(((i + 0.5) * width) / STRIPES.length) - 4
                        reader.drawImage(frame, x, (height >> 1) - 4, 8, 8, 0, 0, 8, 8)
                        const block = reader.getImageData(0, 0, 8, 8).data
                        return [0, 1, 2].map(
                            (c) =>
                                block.reduce((sum, v, k) => (k % 4 === c ? sum + v : sum), 0) / 64,
                        )
                    })
                    decoded.set(index, means)
                } catch (error) {
                    fail(error)
                } finally {
                    frame.close()
                }
            },
            error: fail,
        })
        decoder.configure(decoderConfig)
        for (const chunk of chunks) decoder.decode(chunk)
        await wait(decoder.flush())
    } catch {
        return undefined
    } finally {
        signal?.removeEventListener('abort', aborted)
        if (encoder && encoder.state !== 'closed') encoder.close()
        if (decoder && decoder.state !== 'closed') decoder.close()
    }
    const captured = decoded.get(0)
    // The comparison holds only if the decoder converted every frame the same way.
    if (!captured || decoded.size !== inputs.size || spaces.size !== 1) return undefined
    const distances = colorCandidates.map((_, i) => {
        const means = decoded.get(i + 1) ?? []
        return (
            means.reduce((sum, value, k) => sum + Math.abs(value - (captured[k] ?? 0)), 0) /
            means.length
        )
    })
    return chooseColor(distances)
}
