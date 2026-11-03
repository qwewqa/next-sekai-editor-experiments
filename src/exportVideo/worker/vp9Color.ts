import {
    colorSpaceOf,
    reportedCodes,
    sameMatrix,
    type ColorCodes,
    type MeasuredColor,
} from './avcColor'

// VP9 color_space values with an H.273 matrix that mediabunny's key frame rewrite maps back to
// the same value. CS_RGB (7) has no range bit and a different layout, so it is never written.
const spaceMatrix: Record<number, number> = { 1: 5, 2: 1, 3: 6 }
const matrixSpace: Record<number, number> = { 1: 2, 5: 1, 6: 3 }
const RGB = 7

type Header = { spaceAt: number; space: number; range?: 0 | 1 }

/** The colour fields of an uncompressed VP9 key frame header, or undefined. */
const readHeader = (data: Uint8Array): Header | undefined => {
    let position = 0
    const read = (count: number) => {
        let value = 0
        for (let i = 0; i < count; i++, position++) {
            const byte = data[position >> 3]
            if (byte === undefined) throw new Error('Truncated VP9 frame header')
            value = (value << 1) | ((byte >> (7 - (position & 7))) & 1)
        }
        return value
    }
    try {
        if (read(2) !== 2) return undefined // frame_marker
        const profile = read(1) | (read(1) << 1)
        if (profile === 3) read(1) // reserved_zero
        if (read(1)) return undefined // show_existing_frame
        if (read(1)) return undefined // frame_type: not a key frame
        read(2) // show_frame, error_resilient_mode
        if (read(24) !== 0x498342) return undefined // frame_sync_code
        if (profile >= 2) read(1) // ten_or_twelve_bit
        const spaceAt = position
        const space = read(3)
        return { spaceAt, space, range: space === RGB ? undefined : (read(1) as 0 | 1) }
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

type Target = { space: number; range: 0 | 1 }

const resolve = (
    header: Header | undefined,
    reported: ColorCodes,
    measured?: MeasuredColor,
): { target?: Target; space?: number; range?: 0 | 1 } => {
    // An unread first frame leaves the frames as written and the container with the report.
    if (!header) return { space: matrixSpace[reported.matrix ?? -1], range: reported.range }
    // RGB is full range. Its matrix stays undeclared so that mediabunny leaves the frames alone.
    if (header.range === undefined) return { range: 1 }
    let space = header.space || (matrixSpace[reported.matrix ?? -1] ?? 0)
    if (measured) {
        const measuredSpace = measured.matrix === 'bt709' ? 2 : 3
        if (!sameMatrix(spaceMatrix[header.space], spaceMatrix[measuredSpace]))
            space = measuredSpace
    }
    const range = measured ? (measured.fullRange ? 1 : 0) : header.range
    return { target: { space, range }, space, range }
}

/**
 * Resolves the colour of a VP9 track and writes its matrix and range into every key frame. Per
 * field: the measured conversion, then the first key frame's header, then the encoder's report.
 * A frame that cannot be read passes unchanged. Returns the configuration with the container
 * colour for the frames as written.
 */
export const createVp9Color = (measured?: MeasuredColor) => {
    let resolved = false
    let target: Target | undefined
    let colorSpace: VideoColorSpaceInit | undefined
    return (
        data: Uint8Array,
        type: EncodedVideoChunkType,
        config?: VideoDecoderConfig,
    ): VideoDecoderConfig | undefined => {
        const header = type === 'key' ? readHeader(data) : undefined
        if (config && !resolved) {
            resolved = true
            const reported = reportedCodes(config.colorSpace)
            const track = resolve(header, reported, measured)
            target = track.target
            colorSpace = colorSpaceOf({
                primaries: reported.primaries,
                transfer: reported.transfer,
                matrix: spaceMatrix[track.space ?? -1],
                range: track.range,
            })
        }
        if (header?.range !== undefined && target) {
            writeBits(data, header.spaceAt, 3, target.space)
            writeBits(data, header.spaceAt + 3, 1, target.range)
        }
        return config && { ...config, colorSpace }
    }
}
