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

export type BitReader = ReturnType<typeof bitReader>

/** The bits of an H.264 NAL unit without emulation prevention. */
export const rbspBits = (nal: Uint8Array) => {
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
export const readSpsChroma = (r: BitReader, profile: number) => {
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
