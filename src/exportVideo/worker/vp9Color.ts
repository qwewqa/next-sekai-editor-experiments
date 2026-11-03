import { colorSpaceOf, reportedCodes, sameMatrix, type MeasuredColor } from './avcColor'
import { readVp9KeyFrame } from './bitstream'

// The H.273 matrix of each VP9 color_space value with one, and back.
const spaceMatrix: Record<number, number> = { 1: 5, 2: 1, 3: 6 }
const matrixSpace: Record<number, number> = { 1: 2, 5: 1, 6: 3 }

type Header = { spaceAt: number; space: number; range: 0 | 1 }

/** The colour fields of a profile 0 YUV key frame header, or undefined for any other frame. */
const readHeader = (data: Uint8Array): Header | undefined => {
    try {
        const header = readVp9KeyFrame(data)
        if (header?.profile !== 0) return undefined
        const { r } = header
        const spaceAt = r.at
        const space = r.read(3)
        // CS_RGB has no range bit and a different layout.
        if (space === 7) return undefined
        return { spaceAt, space, range: r.read() as 0 | 1 }
    } catch {
        return undefined
    }
}

const writeBits = (data: Uint8Array, at: number, count: number, value: number) => {
    for (let i = 0; i < count; i++) {
        const bit = at + i
        const mask = 1 << (7 - (bit & 7))
        const index = bit >> 3
        const byte = data[index] ?? 0
        data[index] = (value >> (count - 1 - i)) & 1 ? byte | mask : byte & ~mask
    }
}

/**
 * Resolves the colour of a VP9 track from its first key frame and writes the matrix and range
 * into every profile 0 YUV key frame. Per field: the measured conversion, then the header, then
 * the encoder's report. Other frames pass unchanged. The returned configuration carries the
 * container colour; its matrix stays unspecified, so that only the headers declare it and
 * mediabunny does not rewrite them.
 */
export const createVp9Color = (measured?: MeasuredColor) => {
    let resolved = false
    let target: { space: number; range: 0 | 1 } | undefined
    let colorSpace: VideoColorSpaceInit | undefined
    return (
        data: Uint8Array,
        type: EncodedVideoChunkType,
        config?: VideoDecoderConfig,
    ): VideoDecoderConfig | undefined => {
        const header = type === 'key' ? readHeader(data) : undefined
        if (config && !resolved) {
            resolved = true
            // An unread first frame leaves every frame as written and declares no colour.
            if (header) {
                const reported = reportedCodes(config.colorSpace)
                let space = header.space || (matrixSpace[reported.matrix ?? -1] ?? 0)
                if (measured) {
                    const measuredSpace = measured.matrix === 'bt709' ? 2 : 3
                    if (!sameMatrix(spaceMatrix[header.space], spaceMatrix[measuredSpace]))
                        space = measuredSpace
                }
                const range = measured ? (measured.fullRange ? 1 : 0) : header.range
                target = { space, range }
                colorSpace = colorSpaceOf({
                    primaries: reported.primaries,
                    transfer: reported.transfer,
                    range,
                })
            }
        }
        if (header && target) {
            writeBits(data, header.spaceAt, 3, target.space)
            writeBits(data, header.spaceAt + 3, 1, target.range)
        }
        return config && { ...config, colorSpace }
    }
}
