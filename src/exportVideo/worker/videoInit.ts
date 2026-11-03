// The essential initialization of encoded video: what decoders need, apart from colour.

import {
    bytesOf,
    readAvcSets,
    readAvcSpsList,
    readSpsHead,
    readVp9KeyFrame,
    toBits,
} from './bitstream'

type VideoSize = { width: number; height: number }

/**
 * The displayed size of an SPS, and its bits without `video_signal_type`, the colour part of
 * its VUI. A syntax error before the VUI throws; the VUI is read only as far as colour.
 */
const readSps = (nal: Uint8Array) => {
    const { bits, r, size } = readSpsHead(nal)
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
    return { size, essential: essential.replace(/0*$/, '') }
}

/**
 * Reads an AVC configuration record: each SPS and PPS complete with its own NAL header, and the
 * first SPS of the record's profile. Firefox's encoder repeats the NAL header byte, so its SPS
 * starts with the header again, and no decoder reads such a record. Undefined when any of that
 * fails. The size is read from the first SPS where it can be; an SPS that cannot be read is
 * essential as a whole.
 */
export const readAvcRecord = (description: AllowSharedBufferSource) => {
    const bytes = bytesOf(description)
    const sps = readAvcSpsList(bytes)
    const pps = sps && readAvcSets(bytes, sps.end + 1, bytes[sps.end] ?? 0)
    // More than a NAL header, with forbidden_zero_bit 0 and the set's nal_unit_type.
    const valid = (sets: Uint8Array[], type: number) =>
        sets.every((set) => set.length > 1 && ((set[0] ?? 0) & 0x9f) === type)
    if (!sps || !pps || !valid(sps.sets, 7) || !valid(pps.sets, 8)) return undefined
    if (sps.sets[0]?.[1] !== bytes[1]) return undefined
    const parsed = sps.sets.map((set) => {
        try {
            return readSps(set)
        } catch {
            return { size: undefined, essential: toBits(set) }
        }
    })
    return {
        codec: `avc1.${[...bytes.subarray(1, 4)].map((b) => b.toString(16).padStart(2, '0')).join('')}`,
        size: parsed[0]?.size,
        essential: [
            toBits(bytes.subarray(1, 5)),
            ...parsed.map((s) => s.essential),
            ...pps.sets.map(toBits),
            toBits(bytes.subarray(pps.end)),
        ].join('|'),
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
