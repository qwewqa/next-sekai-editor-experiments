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
export type ColorCodes = { primaries?: number; transfer?: number; matrix?: number; range?: 0 | 1 }

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

const byteBits = (value: number) => value.toString(2).padStart(8, '0')

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
    const bytes = ArrayBuffer.isView(description)
        ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
        : new Uint8Array(description)
    const records = readAvcC(bytes)
    if (!records) return passed
    let parsed: ParsedSps[]
    try {
        parsed = records.sps.map(({ start, end }) => parseSps(bytes.subarray(start, end)))
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

/** The SPS ranges in an AVCDecoderConfigurationRecord, or undefined when it is malformed. */
const readAvcC = (bytes: Uint8Array) => {
    const count = (bytes[5] ?? 0) & 31
    if (bytes[0] !== 1 || !count) return undefined
    const sps: { start: number; end: number }[] = []
    let at = 6
    for (let i = 0; i < count; i++) {
        const high = bytes[at]
        const low = bytes[at + 1]
        if (high === undefined || low === undefined) return undefined
        const size = (high << 8) | low
        at += 2
        if (!size || at + size > bytes.length) return undefined
        sps.push({ start: at, end: at + size })
        at += size
    }
    return { sps, end: at }
}

const parseSps = (sps: Uint8Array): ParsedSps => {
    // Remove emulation prevention before reading H.264 sequence_parameter_set_rbsp.
    let zeros = 0
    const unescaped: number[] = []
    for (const value of sps) {
        if (zeros >= 2 && value === 3) {
            zeros = 0
            continue
        }
        unescaped.push(value)
        zeros = value === 0 ? zeros + 1 : 0
    }
    const bits = unescaped.map(byteBits).join('')
    let position = 0
    const read = (count = 1): number => {
        if (position + count > bits.length) throw new Error('Truncated AVC sequence parameter set')
        const value = count ? parseInt(bits.slice(position, position + count), 2) : 0
        position += count
        return value
    }
    const ue = (): number => {
        let zeros = 0
        while (!read()) {
            if (++zeros > 31) throw new Error('Invalid AVC Exp-Golomb value')
        }
        return 2 ** zeros - 1 + read(zeros)
    }
    if ((read(8) & 31) !== 7) throw new Error('Expected AVC sequence parameter set')
    const profile = read(8)
    read(16) // constraints and level_idc
    ue() // seq_parameter_set_id
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
        const chroma = ue()
        if (chroma === 3) read() // separate_colour_plane_flag
        ue() // bit_depth_luma_minus8
        ue() // bit_depth_chroma_minus8
        read() // qpprime_y_zero_transform_bypass_flag
        if (read()) {
            for (let i = 0; i < (chroma === 3 ? 12 : 8); i++) {
                if (!read()) continue
                let last = 8
                let next = 8
                for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
                    if (next) {
                        const code = ue()
                        const delta = code % 2 ? (code + 1) / 2 : -code / 2
                        next = (last + delta + 256) % 256
                    }
                    last = next || last
                }
            }
        }
    }
    ue() // log2_max_frame_num_minus4
    const order = ue()
    if (order === 0)
        ue() // log2_max_pic_order_cnt_lsb_minus4
    else if (order === 1) {
        read() // delta_pic_order_always_zero_flag
        ue() // offset_for_non_ref_pic (signed; only skipping)
        ue() // offset_for_top_to_bottom_field
        const count = ue()
        for (let i = 0; i < count; i++) ue()
    }
    ue() // max_num_ref_frames
    read() // gaps_in_frame_num_value_allowed_flag
    ue() // pic_width_in_mbs_minus1
    ue() // pic_height_in_map_units_minus1
    if (!read()) read() // frame_mbs_only_flag, mb_adaptive_frame_field_flag
    read() // direct_8x8_inference_flag
    if (read()) for (let i = 0; i < 4; i++) ue() // frame crop offsets
    const unspecified = { primaries: 2, transfer: 2, matrix: 2 }
    let start = position
    let parsed: Omit<ParsedSps, 'bits' | 'start' | 'end'>
    if (!read()) {
        // New VUI: no aspect ratio, overscan, chroma location, timing, HRD or restrictions.
        parsed = { lead: '1001101', tail: '000000', declared: unspecified }
    } else {
        if (read() && read(8) === 255) read(32) // aspect_ratio_info, Extended_SAR
        if (read()) read() // overscan_info
        start = position
        if (!read()) {
            // New video_signal_type with an unspecified video_format.
            parsed = { lead: '1101', tail: '', declared: unspecified }
        } else {
            read(3) // video_format
            start = position
            const range = read() as 0 | 1
            const declared = read()
                ? { primaries: read(8), transfer: read(8), matrix: read(8) }
                : unspecified
            parsed = { lead: '', tail: '', declared: { ...declared, range } }
        }
    }
    // The patch keeps everything after the colour fields, which must end in rbsp_stop_one_bit.
    if (!bits.slice(position).includes('1')) throw new Error('Truncated AVC sequence parameter set')
    return { bits, start, end: position, ...parsed }
}

const patchSps = (sps: ParsedSps, target: Required<Declared>) => {
    const fields = `${target.range}1${[target.primaries, target.transfer, target.matrix].map(byteBits).join('')}`
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
