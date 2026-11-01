const primaries = { bt709: 1, bt470bg: 5, smpte170m: 6 }
const transfers = { bt709: 1, smpte170m: 6, 'iec61966-2-1': 13 }
const matrices = { rgb: 0, bt709: 1, bt470bg: 5, smpte170m: 6 }

const byteBits = (value: number) => value.toString(2).padStart(8, '0')

/** Fill absent colour fields in the SPS from the encoder's description of its YUV output. */
export const withAvcColor = (config: VideoDecoderConfig): VideoDecoderConfig => {
    if (!config.codec.startsWith('avc1.')) return config
    const color = config.colorSpace
    if (
        !config.description ||
        !color?.primaries ||
        !color.transfer ||
        !color.matrix ||
        color.fullRange == null
    )
        throw new Error('H.264 colour configuration is missing')
    const values = [primaries[color.primaries], transfers[color.transfer], matrices[color.matrix]]
    const description = config.description
    const bytes = ArrayBuffer.isView(description)
        ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
        : new Uint8Array(description)
    const count = (bytes[5] ?? 0) & 31
    if (bytes[0] !== 1 || !count) throw new Error('Invalid AVC configuration')
    const result = Array.from(bytes.subarray(0, 6))
    let at = 6
    for (let i = 0; i < count; i++) {
        const high = bytes[at]
        const low = bytes[at + 1]
        if (high === undefined || low === undefined) throw new Error('Truncated AVC configuration')
        const size = (high << 8) | low
        at += 2
        if (!size || at + size > bytes.length) throw new Error('Invalid AVC sequence parameter set')
        const sps = fillColor(bytes.subarray(at, at + size), values, color.fullRange)
        if (sps.length > 65535) throw new Error('AVC sequence parameter set is too large')
        result.push(sps.length >> 8, sps.length & 255, ...sps)
        at += size
    }
    result.push(...bytes.subarray(at))
    return { ...config, description: new Uint8Array(result) }
}

const fillColor = (sps: Uint8Array, values: number[], fullRange: boolean) => {
    // Remove emulation prevention before reading H.264 sequence_parameter_set_rbsp.
    const bits = Array.from(sps)
        .filter((value, i) => !(value === 3 && sps[i - 1] === 0 && sps[i - 2] === 0))
        .map(byteBits)
        .join('')
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
    let start = position
    let replacement: string
    const fields = `${Number(fullRange)}1${values.map(byteBits).join('')}`
    if (!read()) {
        // New VUI: no aspect ratio, overscan, chroma location, timing, HRD or restrictions.
        replacement = `1001101${fields}000000`
    } else {
        if (read() && read(8) === 255) read(32) // aspect_ratio_info, Extended_SAR
        if (read()) read() // overscan_info
        start = position
        if (!read())
            replacement = `1101${fields}` // unspecified video_format
        else {
            read(3) // video_format
            if (read() !== Number(fullRange)) throw new Error('Conflicting H.264 colour range')
            start = position
            if (!read()) replacement = `1${values.map(byteBits).join('')}`
            else {
                start = position
                for (const value of values) {
                    const declared = read(8)
                    if (declared !== 2 && declared !== value)
                        throw new Error('Conflicting H.264 colour description')
                }
                replacement = values.map(byteBits).join('')
            }
        }
    }
    // Keep rbsp_stop_one_bit and all later VUI fields, then restore byte alignment.
    const patched = (bits.slice(0, start) + replacement + bits.slice(position)).replace(/0+$/, '')
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
