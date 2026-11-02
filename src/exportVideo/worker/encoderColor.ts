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

/** The candidate to declare instead of the report, when it clearly decodes closer. */
export const chooseColor = (
    distances: readonly number[],
    reported: VideoColorSpaceInit | undefined,
): ColorCandidate | undefined => {
    const matrix = reported?.matrix === 'bt470bg' ? 'smpte170m' : reported?.matrix
    const current = colorCandidates.findIndex(
        (c) => c.matrix === matrix && c.fullRange === reported?.fullRange,
    )
    const best = distances.indexOf(Math.min(...distances))
    const distance = distances[best] ?? Infinity
    if (
        best === current ||
        distance > MATCH ||
        distance + MATCH >= (distances[current] ?? Infinity)
    )
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
 * Encodes the stripes as the export captures them, then as I420 frames made with each candidate,
 * and decodes all of them with one decoder. The candidate whose frame decodes like the captured
 * one is the encoder's conversion.
 */
export const measureEncoderColor = async (
    config: VideoEncoderConfig,
    frameRate: 30 | 60,
    capture: (edges: readonly number[]) => VideoFrame,
): Promise<ColorCandidate | undefined> => {
    const { width, height } = config
    const edges = stripeEdges(width)
    const chunks: EncodedVideoChunk[] = []
    let decoderConfig: VideoDecoderConfig | undefined
    let failure: Error | undefined
    const check = () => {
        if (failure) throw failure
    }
    const fail = (error: unknown) => {
        failure ??= exportError(error)
    }
    const encoder = new VideoEncoder({
        output: (chunk, metadata) => {
            chunks.push(chunk)
            decoderConfig ??= metadata?.decoderConfig
        },
        error: fail,
    })
    let decoder: VideoDecoder | undefined
    const encode = (frame: VideoFrame) => {
        try {
            encoder.encode(frame, { keyFrame: true })
        } finally {
            frame.close()
        }
    }
    const decoded: number[][] = []
    const spaces = new Set<string>()
    try {
        encoder.configure(config)
        encode(capture(edges))
        await encoder.flush()
        if (!decoderConfig) throw new Error('Encoder omitted its configuration')
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
                    colorSpace: decoderConfig.colorSpace,
                }),
            )
        }
        await encoder.flush()
        check()
        if (!(await VideoDecoder.isConfigSupported(decoderConfig)).supported) return undefined
        const reader = new OffscreenCanvas(8, 8).getContext('2d', {
            willReadFrequently: true,
        })
        if (!reader) throw new Error('2D canvas is unavailable')
        decoder = new VideoDecoder({
            output: (frame) => {
                try {
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
                    decoded.push(means)
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
        await decoder.flush()
        check()
    } catch (error) {
        throw failure ?? exportError(error)
    } finally {
        if (encoder.state !== 'closed') encoder.close()
        if (decoder && decoder.state !== 'closed') decoder.close()
    }
    const [captured, ...candidates] = decoded
    // The comparison holds only if the decoder converted every frame the same way.
    if (!captured || candidates.length !== colorCandidates.length || spaces.size !== 1)
        return undefined
    const distances = candidates.map(
        (means) =>
            means.reduce((sum, value, i) => sum + Math.abs(value - (captured[i] ?? 0)), 0) /
            means.length,
    )
    return chooseColor(distances, decoderConfig.colorSpace)
}
