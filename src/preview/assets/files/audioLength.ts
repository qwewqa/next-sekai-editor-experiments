// How long a clip is, read from its container before anything decodes it (Part 2, 2.5.5): a few
// MB of compressed audio can decode to GB of samples, so the 120 s cap is checked first. Each
// reader takes the most a decoder could make of the bytes, never what a header merely claims:
// a WAV's bytes after `data`, the frames of an MP3, ADTS or FLAC stream, the packets of an Ogg
// stream, the sample count of an MP4 track.

export type ClipLength = { seconds: number; channels: number }

const ascii = (bytes: Uint8Array, at: number, length: number) =>
    String.fromCharCode(...bytes.subarray(at, at + length))

/** A byte, or 0 past the end. */
const byteAt = (bytes: Uint8Array, at: number) => bytes[at] ?? 0

const viewOf = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

/** The length of a clip in a format the editor can measure; undefined for any other. */
export const measureClip = (bytes: Uint8Array): ClipLength | undefined => {
    if (bytes.length < 12) return
    if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') return measureWav(bytes)
    if (ascii(bytes, 0, 4) === 'OggS') return measureOgg(bytes)
    if (ascii(bytes, 4, 4) === 'ftyp') return measureMp4(bytes)
    const start = afterId3(bytes)
    if (ascii(bytes, start, 4) === 'fLaC') return measureFlac(bytes, start)
    return measureFrames(bytes, start)
}

/** Where the audio starts after any ID3v2 tags. */
const afterId3 = (bytes: Uint8Array) => {
    let at = 0
    while (at + 10 <= bytes.length && ascii(bytes, at, 3) === 'ID3') {
        const size =
            ((byteAt(bytes, at + 6) & 0x7f) << 21) |
            ((byteAt(bytes, at + 7) & 0x7f) << 14) |
            ((byteAt(bytes, at + 8) & 0x7f) << 7) |
            (byteAt(bytes, at + 9) & 0x7f)
        // A footer adds 10 more bytes.
        at += 10 + size + (byteAt(bytes, at + 5) & 0x10 ? 10 : 0)
    }
    return at
}

// WAV: PCM, float, A-law and µ-law only, whose length follows from the bytes themselves.
const measureWav = (bytes: Uint8Array): ClipLength | undefined => {
    const view = viewOf(bytes)
    let format: { tag: number; channels: number; rate: number; block: number } | undefined
    let at = 12
    while (at + 8 <= bytes.length) {
        const id = ascii(bytes, at, 4)
        const size = view.getUint32(at + 4, true)
        if (id === 'fmt ' && at + 24 <= bytes.length) {
            let tag = view.getUint16(at + 8, true)
            // WAVE_FORMAT_EXTENSIBLE: the real format is the subformat's first two bytes.
            if (tag === 0xfffe && at + 34 <= bytes.length) tag = view.getUint16(at + 32, true)
            format = {
                tag,
                channels: view.getUint16(at + 10, true),
                rate: view.getUint32(at + 12, true),
                block: view.getUint16(at + 20, true),
            }
        } else if (id === 'data') {
            if (!format || ![1, 3, 6, 7].includes(format.tag)) return
            const { channels, rate, block } = format
            if (!channels || !rate || !block) return
            // Every byte to the end, whatever the chunk declares.
            const frames = Math.floor((bytes.length - at - 8) / block)
            return { seconds: frames / rate, channels }
        }
        at += 8 + size + (size & 1)
    }
    return
}

const crc8 = (bytes: Uint8Array, from: number, to: number) => {
    let crc = 0
    for (let i = from; i < to; i++) {
        crc ^= byteAt(bytes, i)
        for (let bit = 0; bit < 8; bit++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : crc << 1
    }
    return crc & 0xff
}

/** A FLAC frame header's block size at `at`, when a valid header (its CRC-8 included) is there. */
const flacFrameSamples = (bytes: Uint8Array, at: number): number | undefined => {
    if (bytes[at] !== 0xff || (byteAt(bytes, at + 1) & 0xfe) !== 0xf8 || at + 6 > bytes.length)
        return
    const sizeCode = byteAt(bytes, at + 2) >> 4
    const rateCode = byteAt(bytes, at + 2) & 0x0f
    const channelCode = byteAt(bytes, at + 3) >> 4
    if (sizeCode === 0 || rateCode === 15 || channelCode > 10 || byteAt(bytes, at + 3) & 1) return
    // The frame or sample number, coded as UTF-8 is, in 1 to 7 bytes.
    const lead = byteAt(bytes, at + 4)
    let extra = 0
    if (lead >= 0x80) {
        if (lead >= 0xfe) extra = lead === 0xfe ? 6 : -1
        else for (let mask = 0x40; lead & mask; mask >>= 1) extra++
        if (extra < 1 || extra > 6) return
    }
    let end = at + 5 + extra
    let samples: number
    if (sizeCode === 1) samples = 192
    else if (sizeCode <= 5) samples = 576 << (sizeCode - 2)
    else if (sizeCode === 6) samples = (bytes[end++] ?? 0) + 1
    else if (sizeCode === 7) {
        samples = (((bytes[end] ?? 0) << 8) | (bytes[end + 1] ?? 0)) + 1
        end += 2
    } else samples = 256 << (sizeCode - 8)
    end += rateCode === 12 ? 1 : rateCode === 13 || rateCode === 14 ? 2 : 0
    if (end >= bytes.length) return
    return crc8(bytes, at, end) === bytes[end] ? samples : undefined
}

// FLAC: every valid frame header in the stream counts, wherever it is, since a decoder finds
// frames by their sync code; STREAMINFO gives the rate.
const measureFlac = (bytes: Uint8Array, start: number): ClipLength | undefined => {
    const info = start + 8
    if (info + 18 > bytes.length || (byteAt(bytes, start + 4) & 0x7f) !== 0) return
    const rate =
        (byteAt(bytes, info + 10) << 12) |
        (byteAt(bytes, info + 11) << 4) |
        (byteAt(bytes, info + 12) >> 4)
    const channels = ((byteAt(bytes, info + 12) >> 1) & 7) + 1
    if (!rate) return
    let samples = 0
    for (let at = info + 34; at + 6 <= bytes.length; at++)
        samples += flacFrameSamples(bytes, at) ?? 0
    return { seconds: samples / rate, channels }
}

const MP3_RATES = [
    [11025, 12000, 8000],
    [0, 0, 0],
    [22050, 24000, 16000],
    [44100, 48000, 32000],
]
// Kbit/s by version (1, or 2 and 2.5) and layer (1, 2, 3).
const MP3_BITRATES = {
    v1: [
        [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
        [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
        [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    ],
    v2: [
        [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
        [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
        [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    ],
}
const ADTS_RATES = [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
]

type Frame = { length: number; samples: number; rate: number; channels: number }

const mp3Frame = (bytes: Uint8Array, at: number): Frame | undefined => {
    if (at + 4 > bytes.length || bytes[at] !== 0xff || (byteAt(bytes, at + 1) & 0xe0) !== 0xe0)
        return
    const version = (byteAt(bytes, at + 1) >> 3) & 3
    const layer = 4 - ((byteAt(bytes, at + 1) >> 1) & 3)
    const bitrateIndex = byteAt(bytes, at + 2) >> 4
    const rateIndex = (byteAt(bytes, at + 2) >> 2) & 3
    if (version === 1 || layer === 4 || bitrateIndex === 0 || bitrateIndex === 15) return
    if (rateIndex === 3) return
    const rate = MP3_RATES[version]?.[rateIndex] ?? 0
    const bitrate =
        (version === 3 ? MP3_BITRATES.v1 : MP3_BITRATES.v2)[layer - 1]?.[bitrateIndex] ?? 0
    if (!rate || !bitrate) return
    const padding = (byteAt(bytes, at + 2) >> 1) & 1
    const channels = byteAt(bytes, at + 3) >> 6 === 3 ? 1 : 2
    if (layer === 1)
        return {
            length: (Math.floor((12000 * bitrate) / rate) + padding) * 4,
            samples: 384,
            rate,
            channels,
        }
    const perFrame = layer === 3 && version !== 3 ? 576 : 1152
    return {
        length: Math.floor(((perFrame / 8) * 1000 * bitrate) / rate) + padding,
        samples: perFrame,
        rate,
        channels,
    }
}

const adtsFrame = (bytes: Uint8Array, at: number): Frame | undefined => {
    if (at + 7 > bytes.length || bytes[at] !== 0xff || (byteAt(bytes, at + 1) & 0xf6) !== 0xf0)
        return
    const rate = ADTS_RATES[(byteAt(bytes, at + 2) >> 2) & 0x0f]
    const length =
        ((byteAt(bytes, at + 3) & 3) << 11) |
        (byteAt(bytes, at + 4) << 3) |
        (byteAt(bytes, at + 5) >> 5)
    if (!rate || length < 7) return
    const channels = ((byteAt(bytes, at + 2) & 1) << 2) | (byteAt(bytes, at + 3) >> 6) || 2
    return { length, samples: ((byteAt(bytes, at + 6) & 3) + 1) * 1024, rate, channels }
}

// MP3 and ADTS AAC: frame by frame, as a decoder walks them, scanning past anything else to the
// next frame header.
const measureFrames = (bytes: Uint8Array, start: number): ClipLength | undefined => {
    const isAdts = bytes[start] === 0xff && (byteAt(bytes, start + 1) & 0xf6) === 0xf0
    const frameAt = isAdts ? adtsFrame : mp3Frame
    let seconds = 0
    let channels = 0
    let frames = 0
    for (let at = start; at < bytes.length;) {
        const frame = frameAt(bytes, at)
        if (!frame) {
            at++
            continue
        }
        frames++
        seconds += frame.samples / frame.rate
        channels = Math.max(channels, frame.channels)
        at += frame.length
    }
    return frames ? { seconds, channels } : undefined
}

/** Samples in an Opus packet, from its TOC byte (RFC 6716, 3.1), at 48 kHz. */
const opusSamples = (toc: number, second: number | undefined) => {
    const config = toc >> 3
    // Frame sizes in units of 2.5 ms.
    const size =
        config < 12
            ? ([4, 8, 16, 24][config & 3] ?? 0)
            : config < 16
              ? ([4, 8][config & 1] ?? 0)
              : 1 << (config & 3)
    const code = toc & 3
    const frames = code === 0 ? 1 : code < 3 ? 2 : (second ?? 0) & 0x3f
    return frames * size * 120
}

// Ogg: the packets of its one stream. Opus packets say their own length; a Vorbis packet makes
// at most half its long block.
const measureOgg = (bytes: Uint8Array): ClipLength | undefined => {
    const view = viewOf(bytes)
    let serial: number | undefined
    let codec:
        { kind: 'opus' | 'vorbis'; channels: number; rate: number; perPacket: number } | undefined
    let packets = 0
    let samples = 0
    let packet: number[] = []
    let inPacket = false
    const finish = () => {
        packets++
        if (packets === 1) {
            const head = Uint8Array.from(packet)
            if (head.length >= 10 && ascii(head, 0, 8) === 'OpusHead')
                codec = { kind: 'opus', channels: byteAt(head, 9), rate: 48000, perPacket: 0 }
            else if (head.length >= 29 && head[0] === 1 && ascii(head, 1, 6) === 'vorbis') {
                const headView = viewOf(head)
                codec = {
                    kind: 'vorbis',
                    channels: byteAt(head, 11),
                    rate: headView.getUint32(12, true),
                    perPacket: (1 << (byteAt(head, 28) >> 4)) / 2,
                }
            }
        } else if (codec) {
            const headers = codec.kind === 'opus' ? 2 : 3
            if (packets > headers)
                samples +=
                    codec.kind === 'opus' ? opusSamples(packet[0] ?? 0, packet[1]) : codec.perPacket
        }
        packet = []
        inPacket = false
    }
    for (let at = 0; at + 27 <= bytes.length;) {
        if (ascii(bytes, at, 4) !== 'OggS' || bytes[at + 4] !== 0) {
            at++
            continue
        }
        const pageSerial = view.getUint32(at + 14, true)
        if (serial === undefined) serial = pageSerial
        // A second stream, chained or multiplexed, is not measured.
        else if (pageSerial !== serial) return
        const segments = byteAt(bytes, at + 26)
        let data = at + 27 + segments
        if (data > bytes.length) break
        // A page that does not continue a packet starts a new one.
        if (!(byteAt(bytes, at + 5) & 1) && inPacket) finish()
        for (let i = 0; i < segments; i++) {
            const lacing = byteAt(bytes, at + 27 + i)
            inPacket = true
            for (let b = data; b < Math.min(data + lacing, bytes.length) && packet.length < 32; b++)
                packet.push(byteAt(bytes, b))
            data += lacing
            if (lacing < 255) finish()
        }
        at = Math.max(data, at + 1)
    }
    if (inPacket) finish()
    if (!codec?.rate || !codec.channels) return
    return { seconds: samples / codec.rate, channels: codec.channels }
}

type Box = { type: string; start: number; end: number }

const boxes = (bytes: Uint8Array, from: number, to: number): Box[] => {
    const view = viewOf(bytes)
    const found: Box[] = []
    for (let at = from; at + 8 <= to;) {
        let size = view.getUint32(at)
        let header = 8
        if (size === 1) {
            if (at + 16 > to) break
            size = view.getUint32(at + 8) * 2 ** 32 + view.getUint32(at + 12)
            header = 16
        } else if (size === 0) size = to - at
        if (size < header || at + size > to) break
        found.push({ type: ascii(bytes, at + 4, 4), start: at + header, end: at + size })
        at += size
    }
    return found
}

const child = (bytes: Uint8Array, box: Box | undefined, type: string, skip = 0) =>
    box && boxes(bytes, box.start + skip, box.end).find((each) => each.type === type)

/** An MPEG-4 descriptor's tag, body start and end. */
const descriptor = (bytes: Uint8Array, at: number, end: number) => {
    const tag = bytes[at]
    let size = 0
    let i = at + 1
    for (let n = 0; n < 4 && i < end; n++) {
        const byte = byteAt(bytes, i++)
        size = (size << 7) | (byte & 0x7f)
        if (!(byte & 0x80)) break
    }
    return { tag, start: i, end: Math.min(i + size, end) }
}

/** The samples per frame and the core rate of an `mp4a` entry, from its `esds`. */
const mp4aFrames = (bytes: Uint8Array, entry: Box, fallbackRate: number) => {
    // The sample entry's own fields come first: 28 bytes.
    const esds = child(bytes, entry, 'esds', 28)
    if (!esds) return
    const es = descriptor(bytes, esds.start + 4, esds.end)
    if (es.tag !== 3) return
    const flags = bytes[es.start + 2] ?? 0
    let at = es.start + 3
    if (flags & 0x80) at += 2
    if (flags & 0x40) at += 1 + (bytes[at] ?? 0)
    if (flags & 0x20) at += 2
    const config = descriptor(bytes, at, es.end)
    if (config.tag !== 4) return
    const objectType = bytes[config.start]
    // MPEG-1 and MPEG-2 audio (MP3) in MP4: 1152 samples a frame.
    if (objectType === 0x69 || objectType === 0x6b) return { perFrame: 1152, rate: fallbackRate }
    if (objectType !== 0x40 && objectType !== 0x66 && objectType !== 0x67 && objectType !== 0x68)
        return
    // AudioSpecificConfig: the object type, then the core rate, which SBR doubles along with
    // the samples, so the length in seconds is the core's.
    const specific = descriptor(bytes, config.start + 13, config.end)
    if (specific.tag !== 5 || specific.end - specific.start < 2)
        return { perFrame: 1024, rate: fallbackRate }
    const b0 = byteAt(bytes, specific.start)
    const b1 = byteAt(bytes, specific.start + 1)
    const b2 = bytes[specific.start + 2] ?? 0
    const escaped = b0 >> 3 === 31
    const index = escaped ? ((b1 & 0x01) << 3) | (b2 >> 5) : ((b0 & 0x07) << 1) | (b1 >> 7)
    return { perFrame: 1024, rate: ADTS_RATES[index] ?? fallbackRate }
}

// MP4 (M4A): every sound track's sample count from `stsz`; a fragmented file is not measured.
const measureMp4 = (bytes: Uint8Array): ClipLength | undefined => {
    const view = viewOf(bytes)
    const top = boxes(bytes, 0, bytes.length)
    if (top.some((box) => box.type === 'moof')) return
    const moov = top.find((box) => box.type === 'moov')
    if (!moov) return
    let seconds = 0
    let channels = 0
    let tracks = 0
    for (const trak of boxes(bytes, moov.start, moov.end)) {
        if (trak.type !== 'trak') continue
        const mdia = child(bytes, trak, 'mdia')
        const hdlr = child(bytes, mdia, 'hdlr')
        if (!hdlr || ascii(bytes, hdlr.start + 8, 4) !== 'soun') continue
        const stbl = child(bytes, child(bytes, mdia, 'minf'), 'stbl')
        const stsd = child(bytes, stbl, 'stsd')
        const stsz = child(bytes, stbl, 'stsz')
        if (!stsd || !stsz || stsz.start + 12 > stsz.end) return
        const entry = boxes(bytes, stsd.start + 8, stsd.end)[0]
        if (entry?.type !== 'mp4a' || entry.start + 28 > entry.end) return
        const entryChannels = view.getUint16(entry.start + 16)
        const fallbackRate = view.getUint16(entry.start + 24)
        const frames = mp4aFrames(bytes, entry, fallbackRate)
        if (!frames?.rate) return
        const count = view.getUint32(stsz.start + 8)
        seconds += (count * frames.perFrame) / frames.rate
        channels = Math.max(channels, entryChannels || 2)
        tracks++
    }
    return tracks ? { seconds, channels } : undefined
}
