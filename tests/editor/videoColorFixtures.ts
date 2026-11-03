import { ALL_FORMATS, BufferSource, BufferTarget, EncodedPacketSink, Input } from 'mediabunny'
// mediabunny's own SPS reader, independent of the export's.
import { parseAvcSps } from '../../node_modules/mediabunny/dist/modules/src/codec-data.js'
import type { MuxInput } from '../../src/exportVideo/worker/encode'
import { createMuxSink } from '../../src/exportVideo/worker/mux'

/** Muxes video packets and returns the file. */
export const muxVideo = async (format: 'mp4' | 'webm', inputs: MuxInput[]) => {
    const target = new BufferTarget()
    const sink = await createMuxSink(
        {
            codecs: {
                supported: true,
                format,
                video: {
                    codec: format === 'mp4' ? 'avc1.64001e' : 'vp09.00.10.08',
                    width: 16,
                    height: 16,
                },
            },
            frames: inputs.length,
            frameRate: 30,
            samples: 1600,
        },
        target,
    )
    for (const input of inputs) await sink.add(input)
    await sink.finalize()
    return new Uint8Array(target.buffer!)
}

const find = (bytes: Uint8Array, pattern: number[], from = 0) => {
    for (let i = from; i + pattern.length <= bytes.length; i++)
        if (pattern.every((value, k) => bytes[i + k] === value)) return i
    return -1
}

/** The MP4 `colr` box as H.273 codes, or undefined when there is none. */
export const mp4Colr = (file: Uint8Array) => {
    const at = find(
        file,
        [...'colrnclx'].map((c) => c.charCodeAt(0)),
    )
    if (at < 0) return undefined
    const u16 = (offset: number) => (file[at + offset]! << 8) | file[at + offset + 1]!
    return { primaries: u16(8), transfer: u16(10), matrix: u16(12), range: file[at + 14]! >> 7 }
}

/** The SPS records of the MP4 `avcC` box. */
export const mp4AvcC = (file: Uint8Array) => {
    const at = find(
        file,
        [...'avcC'].map((c) => c.charCodeAt(0)),
    )
    const size =
        ((file[at - 4]! << 24) | (file[at - 3]! << 16) | (file[at - 2]! << 8) | file[at - 1]!) >>> 0
    return file.subarray(at + 4, at - 4 + size)
}

/** The colour fields that mediabunny reads from each SPS in an avcC. */
export const spsColors = (avcC: Uint8Array) => {
    const result: { primaries: number; transfer: number; matrix: number; range: number }[] = []
    let at = 6
    for (let i = 0; i < (avcC[5]! & 31); i++) {
        const size = (avcC[at]! << 8) | avcC[at + 1]!
        const sps = parseAvcSps(avcC.subarray(at + 2, at + 2 + size))
        if (!sps) throw new Error('mediabunny cannot read the SPS')
        result.push({
            primaries: sps.colourPrimaries,
            transfer: sps.transferCharacteristics,
            matrix: sps.matrixCoefficients,
            range: sps.fullRangeFlag,
        })
        at += 2 + size
    }
    return result
}

/** The WebM `Colour` element: H.273 codes and the Matroska range, or undefined. */
export const webmColour = (file: Uint8Array) => {
    // An EBML size: the leading zeros of its first byte give its length.
    const size = (at: number) => {
        const length = Math.clz32(file[at]!) - 23
        let value = file[at]! & (0xff >> length)
        for (let k = 1; k < length; k++) value = value * 256 + file[at + k]!
        return { value, length }
    }
    const at = find(file, [0x55, 0xb0])
    if (at < 0) return undefined
    const colour = size(at + 2)
    const end = at + 2 + colour.length + colour.value
    const values: Record<number, number> = {}
    for (let i = at + 2 + colour.length; i < end;) {
        const id = (file[i]! << 8) | file[i + 1]!
        const child = size(i + 2)
        let value = 0
        for (let k = 0; k < child.value; k++) value = value * 256 + file[i + 2 + child.length + k]!
        values[id] = value
        i += 2 + child.length + child.value
    }
    return {
        matrix: values[0x55b1],
        range: values[0x55b9],
        transfer: values[0x55ba],
        primaries: values[0x55bb],
    }
}

/** The muxed bytes of each video packet. */
export const muxedPackets = async (file: Uint8Array) => {
    const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(file) })
    try {
        const track = await input.getPrimaryVideoTrack()
        if (!track) throw new Error('No video track')
        const packets: Uint8Array[] = []
        for await (const packet of new EncodedPacketSink(track).packets())
            packets.push(new Uint8Array(packet.data))
        return packets
    } finally {
        input.dispose()
    }
}

/** The colour fields of a VP9 profile 0 key frame: color_space and color_range. */
export const vp9Fields = (frame: Uint8Array) => ({
    space: (frame[4]! >> 5) & 7,
    range: (frame[4]! >> 4) & 1,
})

/** A VP9 profile 0 key frame header followed by frame size and filler bytes. */
export const vp9KeyFrame = (space: number, range: 0 | 1) =>
    new Uint8Array([0x82, 0x49, 0x83, 0x42, (space << 5) | (range << 4), 0x78, 0x0f, 0, 0x1e, 0])
