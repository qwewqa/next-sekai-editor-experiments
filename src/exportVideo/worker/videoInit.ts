// The essential initialization of encoded video: what decoders need, apart from colour.

import { bitReader, bytesOf, rbspBits, readSpsChroma, readVp9KeyFrame, toBits } from './bitstream'

type VideoSize = { width: number; height: number }

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
    const { chroma, separate } = readSpsChroma(r, profile)
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
        const header = readVp9KeyFrame(data)
        if (!header) return undefined
        const { r, profile } = header
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
