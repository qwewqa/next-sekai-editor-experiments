import { bytesOf, readAvcSpsList, readSpsHead, toBits } from './bitstream'

/** The measured RGB-to-YUV conversion: matrix and range only. */
export type MeasuredColor = { matrix: 'bt709' | 'smpte170m'; fullRange: boolean }

// H.273 code points for the values mediabunny accepts. 2 is unspecified.
const primaryCodes: Record<string, number> = {
    bt709: 1,
    bt470bg: 5,
    smpte170m: 6,
    bt2020: 9,
    smpte432: 12,
}
const transferCodes: Record<string, number> = {
    bt709: 1,
    smpte170m: 6,
    linear: 8,
    'iec61966-2-1': 13,
    pq: 16,
    hlg: 18,
}
const matrixCodes: Record<string, number> = {
    rgb: 0,
    bt709: 1,
    bt470bg: 5,
    smpte170m: 6,
    'bt2020-ncl': 9,
}
const nameOf = (codes: Record<string, number>, code: number | undefined) =>
    Object.keys(codes).find((name) => codes[name] === code)
const codeOf = (codes: Record<string, number>, name: unknown) =>
    typeof name === 'string' && Object.hasOwn(codes, name) ? codes[name] : undefined

/** Colour as H.273 codes; an absent field is unknown. */
type ColorCodes = { primaries?: number; transfer?: number; matrix?: number; range?: 0 | 1 }

/** Reads an encoder's report, dropping null, unknown and malformed fields. */
export const reportedCodes = (color: unknown): ColorCodes => {
    if (!color || typeof color !== 'object') return {}
    const { primaries, transfer, matrix, fullRange } = color as Record<string, unknown>
    return {
        primaries: codeOf(primaryCodes, primaries),
        transfer: codeOf(transferCodes, transfer),
        matrix: codeOf(matrixCodes, matrix),
        range: typeof fullRange === 'boolean' ? (fullRange ? 1 : 0) : undefined,
    }
}

/** A colour space that mediabunny accepts. Codes it has no name for stay unspecified. */
export const colorSpaceOf = (codes: ColorCodes): VideoColorSpaceInit | undefined => {
    const color: VideoColorSpaceInit = {}
    const primaries = nameOf(primaryCodes, codes.primaries)
    const transfer = nameOf(transferCodes, codes.transfer)
    const matrix = nameOf(matrixCodes, codes.matrix)
    if (primaries) color.primaries = primaries as VideoColorPrimaries
    if (transfer) color.transfer = transfer as VideoTransferCharacteristics
    if (matrix) color.matrix = matrix as VideoMatrixCoefficients
    if (codes.range !== undefined) color.fullRange = codes.range === 1
    return Object.keys(color).length ? color : undefined
}

/** BT.470BG and SMPTE 170M have the same coefficients. */
export const sameMatrix = (a: number | undefined, b: number | undefined) =>
    a === b ||
    (a !== undefined && b !== undefined && [a, b].every((code) => code === 5 || code === 6))

type Declared = { primaries: number; transfer: number; matrix: number; range?: 0 | 1 }

type ParsedSps = {
    bits: string
    /** Start and end of the bits that a colour declaration replaces. */
    start: number
    end: number
    /** What precedes the range bit in the replacement. */
    lead: string
    /** What follows the colour description in the replacement. */
    tail: string
    /** Absent fields are unspecified (2); an absent range is not declared. */
    declared: Declared
}

/** The MP4 colour for an SPS. mediabunny writes limited range when range is unknown. */
const mp4Color = (codes: ColorCodes) =>
    codes.range === undefined ? undefined : colorSpaceOf(codes)

/**
 * Resolves the colour of an H.264 track and writes it into every SPS. Per field: the measured
 * matrix and range, then what the first SPS declares, then the encoder's report. The returned
 * `colorSpace` describes the SPS as written. A description that cannot be read passes unchanged,
 * never partly rewritten, and declares no colour.
 */
export const withAvcColor = (
    config: VideoDecoderConfig,
    measured?: MeasuredColor,
): VideoDecoderConfig => {
    const reported = reportedCodes(config.colorSpace)
    const passed = { ...config, colorSpace: undefined }
    const description = config.description
    if (!description) return passed
    const bytes = bytesOf(description)
    const records = readAvcSpsList(bytes)
    if (!records) return passed
    let parsed: ParsedSps[]
    try {
        parsed = records.sets.map(parseSps)
    } catch {
        return passed
    }
    const first = parsed[0]?.declared
    if (!first) return passed
    const measuredMatrix = measured && (measured.matrix === 'bt709' ? 1 : 6)
    const declaredOrReport = (value: number, report: number | undefined) =>
        value !== 2 ? value : (report ?? 2)
    const target = {
        primaries: declaredOrReport(first.primaries, reported.primaries),
        transfer: declaredOrReport(first.transfer, reported.transfer),
        matrix:
            measuredMatrix !== undefined && !sameMatrix(first.matrix, measuredMatrix)
                ? measuredMatrix
                : declaredOrReport(first.matrix, reported.matrix),
        range: measured ? (measured.fullRange ? 1 : 0) : (first.range ?? reported.range ?? 0),
    } as const
    const asWritten = (declared: Declared) => ({ ...declared, range: declared.range ?? 0 })
    const unchanged = parsed.every((sps) => {
        const declared = asWritten(sps.declared)
        return (Object.keys(target) as (keyof typeof target)[]).every(
            (key) => declared[key] === target[key],
        )
    })
    if (unchanged) return { ...config, colorSpace: mp4Color(first) }
    const result = Array.from(bytes.subarray(0, 6))
    for (const sps of parsed) {
        const patched = patchSps(sps, target)
        // The patched SPS must still fit the 16-bit length field.
        if (patched.length > 65535) return { ...config, colorSpace: mp4Color(first) }
        result.push(patched.length >> 8, patched.length & 255, ...patched)
    }
    result.push(...bytes.subarray(records.end))
    return { ...config, description: new Uint8Array(result), colorSpace: mp4Color(target) }
}

const parseSps = (sps: Uint8Array): ParsedSps => {
    const { bits, r } = readSpsHead(sps)
    const { read } = r
    const unspecified = { primaries: 2, transfer: 2, matrix: 2 }
    let start = r.at
    let parsed: Omit<ParsedSps, 'bits' | 'start' | 'end'>
    if (!read()) {
        // New VUI: no aspect ratio, overscan, chroma location, timing, HRD or restrictions.
        parsed = { lead: '1001101', tail: '000000', declared: unspecified }
    } else {
        if (read() && read(8) === 255) read(32) // aspect_ratio_info, Extended_SAR
        if (read()) read() // overscan_info
        start = r.at
        if (!read()) {
            // New video_signal_type with an unspecified video_format.
            parsed = { lead: '1101', tail: '', declared: unspecified }
        } else {
            read(3) // video_format
            start = r.at
            const range = read() as 0 | 1
            const declared = read()
                ? { primaries: read(8), transfer: read(8), matrix: read(8) }
                : unspecified
            parsed = { lead: '', tail: '', declared: { ...declared, range } }
        }
    }
    // The patch keeps everything after the colour fields. That part must end in rbsp_stop_one_bit.
    if (!bits.slice(r.at).includes('1')) throw new Error('Truncated AVC sequence parameter set')
    return { bits, start, end: r.at, ...parsed }
}

const patchSps = (sps: ParsedSps, target: Required<Declared>) => {
    const fields = `${target.range}1${toBits([target.primaries, target.transfer, target.matrix])}`
    // Keep rbsp_stop_one_bit and all later VUI fields, then restore byte alignment.
    const patched = (
        sps.bits.slice(0, sps.start) +
        sps.lead +
        fields +
        sps.tail +
        sps.bits.slice(sps.end)
    ).replace(/0+$/, '')
    const aligned = patched.padEnd(Math.ceil(patched.length / 8) * 8, '0')
    const result: number[] = []
    let zeros = 0
    for (let i = 0; i < aligned.length; i += 8) {
        const value = parseInt(aligned.slice(i, i + 8), 2)
        if (zeros >= 2 && value <= 3) {
            result.push(3)
            zeros = 0
        }
        result.push(value)
        zeros = value === 0 ? zeros + 1 : 0
    }
    return result
}
