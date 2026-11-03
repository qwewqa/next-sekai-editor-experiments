// The essential initialization of encoded video: what decoders need, apart from colour.

const bytesOf = (buffer: AllowSharedBufferSource) =>
    ArrayBuffer.isView(buffer)
        ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
        : new Uint8Array(buffer)

type VideoSize = { width: number; height: number }

const bitReader = (bits: string) => {
    let at = 0
    const read = (count = 1): number => {
        if (at + count > bits.length) throw new Error('Truncated video header')
        const value = count ? parseInt(bits.slice(at, at + count), 2) : 0
        at += count
        return value
    }
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

const toBits = (bytes: Iterable<number>) =>
    Array.from(bytes, (value) => value.toString(2).padStart(8, '0')).join('')

/** H.264 sequence_parameter_set_rbsp bits, without emulation prevention. */
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
 * The displayed size of an SPS, and its bits without `video_signal_type`, the colour part of
 * its VUI. A syntax error before the VUI throws; the VUI is read only as far as colour.
 */
const readSps = (nal: Uint8Array) => {
    const bits = rbspBits(nal)
    const r = bitReader(bits)
    if ((r.read(8) & 0x9f) !== 7) throw new Error('Expected an H.264 sequence parameter set')
    const profile = r.read(8)
    r.read(16)
    r.ue()
    let chroma = 1
    let separate = false
    if (highProfiles.includes(profile)) {
        chroma = r.ue()
        if (chroma === 3) separate = !!r.read()
        r.ue()
        r.ue()
        r.read()
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
    }
    r.ue()
    const order = r.ue()
    if (order === 0) r.ue()
    else if (order === 1) {
        r.read()
        r.ue()
        r.ue()
        const count = r.ue()
        for (let i = 0; i < count; i++) r.ue()
    }
    r.ue()
    r.read()
    const widthMbs = r.ue() + 1
    const heightUnits = r.ue() + 1
    const frameMbsOnly = r.read()
    if (!frameMbsOnly) r.read()
    r.read()
    const crop = r.read() ? [r.ue(), r.ue(), r.ue(), r.ue()] : [0, 0, 0, 0]
    const [left = 0, right = 0, top = 0, bottom = 0] = crop
    const planes = chroma === 0 || separate
    const unitX = planes ? 1 : chroma === 3 ? 1 : 2
    const unitY = (2 - frameMbsOnly) * (planes ? 1 : chroma === 1 ? 2 : 1)
    const size: VideoSize = {
        width: widthMbs * 16 - unitX * (left + right),
        height: (2 - frameMbsOnly) * heightUnits * 16 - unitY * (top + bottom),
    }
    let essential = bits
    try {
        if (r.read()) {
            if (r.read() && r.read(8) === 255) r.read(32)
            if (r.read()) r.read()
            const start = r.at
            if (r.read()) {
                r.read(4)
                if (r.read()) r.read(24)
            }
            essential = bits.slice(0, start) + bits.slice(r.at)
        }
    } catch {
        // A VUI that ends before its colour part leaves the whole SPS essential.
    }
    // The stop bit and its zero padding move with the colour bits.
    return { profile, size, essential: essential.replace(/0*$/, '') }
}

/**
 * Reads an AVC configuration record: each SPS and PPS complete with its own NAL header, the
 * first SPS of the record's profile and readable up to its VUI. Firefox's encoder repeats the
 * NAL header byte, which no decoder reads. Undefined when any of that fails.
 */
export const readAvcRecord = (description: AllowSharedBufferSource) => {
    const bytes = bytesOf(description)
    let at = 5
    const sets = (count: number, type: number) => {
        const found: Uint8Array[] = []
        for (let i = 0; i < count; i++) {
            const size = ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0)
            const start = at + 2
            at = start + size
            // forbidden_zero_bit 0 and the set's nal_unit_type.
            if (size < 2 || at > bytes.length || ((bytes[start] ?? 0) & 0x9f) !== type)
                return undefined
            found.push(bytes.subarray(start, at))
        }
        return found
    }
    const spsCount = (bytes[at++] ?? 0) & 31
    if (bytes[0] !== 1 || !spsCount) return undefined
    const sps = sets(spsCount, 7)
    const pps = sps && sets(bytes[at++] ?? 0, 8)
    if (!sps || !pps) return undefined
    try {
        const parsed = sps.map(readSps)
        const first = parsed[0]
        if (!first || first.profile !== bytes[1]) return undefined
        return {
            codec: `avc1.${[...bytes.subarray(1, 4)].map((b) => b.toString(16).padStart(2, '0')).join('')}`,
            size: first.size,
            essential: [
                toBits(bytes.subarray(1, 5)),
                ...parsed.map((s) => s.essential),
                ...pps.map(toBits),
                toBits(bytes.subarray(at)),
            ].join('|'),
        }
    } catch {
        return undefined
    }
}

/** The displayed size in a VP9 key frame's uncompressed header, if it can be read. */
export const vp9FrameSize = (data: Uint8Array): VideoSize | undefined => {
    try {
        const r = bitReader(toBits(data.subarray(0, 16)))
        if (r.read(2) !== 2) return undefined
        const profile = r.read() | (r.read() << 1)
        if (profile === 3) r.read()
        if (r.read() || r.read()) return undefined // show_existing_frame, or not a key frame
        r.read(2)
        if (r.read(24) !== 0x498342) return undefined
        if (profile >= 2) r.read()
        if (r.read(3) !== 7) {
            r.read()
            if (profile % 2) r.read(3)
        } else if (profile % 2) r.read()
        const frame = { width: r.read(16) + 1, height: r.read(16) + 1 }
        return r.read() ? { width: r.read(16) + 1, height: r.read(16) + 1 } : frame
    } catch {
        return undefined
    }
}
