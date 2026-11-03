// Low-level reading of H.264 and VP9 headers, shared by the colour and initialization readers.

export const bytesOf = (buffer: AllowSharedBufferSource) =>
    ArrayBuffer.isView(buffer)
        ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
        : new Uint8Array(buffer)

export const toBits = (bytes: Iterable<number>) =>
    Array.from(bytes, (value) => value.toString(2).padStart(8, '0')).join('')

/** Reads a string of bits. Reading past its end throws. */
export const bitReader = (bits: string) => {
    let at = 0
    const read = (count = 1): number => {
        if (at + count > bits.length) throw new Error('Truncated video header')
        const value = count ? parseInt(bits.slice(at, at + count), 2) : 0
        at += count
        return value
    }
    /** An unsigned Exp-Golomb value. */
    const ue = (): number => {
        let zeros = 0
        while (!read()) if (++zeros > 31) throw new Error('Invalid Exp-Golomb value')
        return 2 ** zeros - 1 + read(zeros)
    }
    return {
        read,
        ue,
        get at() {
            return at
        },
    }
}

type BitReader = ReturnType<typeof bitReader>

/** The bits of an H.264 NAL unit without emulation prevention. */
const rbspBits = (nal: Uint8Array) => {
    let zeros = 0
    const out: number[] = []
    for (const value of nal) {
        if (zeros >= 2 && value === 3) {
            zeros = 0
            continue
        }
        out.push(value)
        zeros = value === 0 ? zeros + 1 : 0
    }
    return toBits(out)
}

const highProfiles = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]

/**
 * Reads an SPS's fields that only high profiles have, after `seq_parameter_set_id`, skipping
 * the scaling lists. Other profiles are 4:2:0.
 */
const readSpsChroma = (r: BitReader, profile: number) => {
    if (!highProfiles.includes(profile)) return { chroma: 1, separate: false }
    const chroma = r.ue()
    const separate = chroma === 3 && !!r.read()
    r.ue() // bit_depth_luma_minus8
    r.ue() // bit_depth_chroma_minus8
    r.read() // qpprime_y_zero_transform_bypass_flag
    if (r.read())
        for (let i = 0; i < (chroma === 3 ? 12 : 8); i++) {
            if (!r.read()) continue
            let last = 8
            let next = 8
            for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
                if (next) {
                    const code = r.ue()
                    next = (last + (code % 2 ? (code + 1) / 2 : -code / 2) + 256) % 256
                }
                last = next || last
            }
        }
    return { chroma, separate }
}

/**
 * Reads an H.264 SPS up to its VUI flag, leaving the reader at the flag. Returns its bits, profile
 * and displayed size. A syntax error throws.
 */
export const readSpsHead = (nal: Uint8Array) => {
    const bits = rbspBits(nal)
    const r = bitReader(bits)
    if ((r.read(8) & 31) !== 7) throw new Error('Expected an H.264 sequence parameter set')
    const profile = r.read(8)
    r.read(16) // constraints and level_idc
    r.ue() // seq_parameter_set_id
    const { chroma, separate } = readSpsChroma(r, profile)
    r.ue() // log2_max_frame_num_minus4
    const order = r.ue()
    if (order === 0)
        r.ue() // log2_max_pic_order_cnt_lsb_minus4
    else if (order === 1) {
        r.read() // delta_pic_order_always_zero_flag
        r.ue() // offset_for_non_ref_pic (signed; only skipping)
        r.ue() // offset_for_top_to_bottom_field
        const count = r.ue()
        for (let i = 0; i < count; i++) r.ue()
    }
    r.ue() // max_num_ref_frames
    r.read() // gaps_in_frame_num_value_allowed_flag
    const widthMbs = r.ue() + 1
    const heightUnits = r.ue() + 1
    const frameMbsOnly = r.read()
    if (!frameMbsOnly) r.read() // mb_adaptive_frame_field_flag
    r.read() // direct_8x8_inference_flag
    const [left = 0, right = 0, top = 0, bottom = 0] = r.read()
        ? [r.ue(), r.ue(), r.ue(), r.ue()]
        : []
    const planes = chroma === 0 || separate
    const unitX = planes ? 1 : chroma === 3 ? 1 : 2
    const unitY = (2 - frameMbsOnly) * (planes ? 1 : chroma === 1 ? 2 : 1)
    const size = {
        width: widthMbs * 16 - unitX * (left + right),
        height: (2 - frameMbsOnly) * heightUnits * 16 - unitY * (top + bottom),
    }
    return { bits, r, profile, size }
}

/**
 * Reads `count` length-prefixed parameter sets of an AVC configuration record from `at`, and the
 * offset after them. Undefined when one is empty or runs past the end.
 */
export const readAvcSets = (bytes: Uint8Array, at: number, count: number) => {
    const sets: Uint8Array[] = []
    for (let i = 0; i < count; i++) {
        const size = ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0)
        const start = at + 2
        at = start + size
        if (!size || at > bytes.length) return undefined
        sets.push(bytes.subarray(start, at))
    }
    return { sets, end: at }
}

/** The SPS list of an AVC configuration record. Undefined for another version, none or a bad set. */
export const readAvcSpsList = (bytes: Uint8Array) => {
    const count = (bytes[5] ?? 0) & 31
    return bytes[0] === 1 && count ? readAvcSets(bytes, 6, count) : undefined
}

/**
 * Reads a VP9 key frame's uncompressed header through its sync code, leaving the reader at the
 * bit depth or colour space. Undefined for any other frame; a truncated header throws.
 */
export const readVp9KeyFrame = (data: Uint8Array) => {
    const r = bitReader(toBits(data.subarray(0, 16)))
    if (r.read(2) !== 2) return undefined // frame_marker
    const profile = r.read() | (r.read() << 1)
    if (profile === 3) r.read() // reserved_zero
    if (r.read() || r.read()) return undefined // show_existing_frame, or not a key frame
    r.read(2) // show_frame, error_resilient_mode
    if (r.read(24) !== 0x498342) return undefined // frame_sync_code
    return { r, profile }
}
