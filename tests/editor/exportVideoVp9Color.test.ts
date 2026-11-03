import assert from 'node:assert/strict'
import test from 'node:test'
import type { MuxInput } from '../../src/exportVideo/worker/encode'
import { createVp9Color } from '../../src/exportVideo/worker/vp9Color'
import { muxedPackets, muxVideo, vp9Fields, vp9KeyFrame, webmColour } from './videoColorFixtures'

const report: VideoColorSpaceInit = {
    primaries: 'bt709',
    transfer: 'bt709',
    matrix: 'bt709',
    fullRange: true,
}
const config = (colorSpace: unknown): VideoDecoderConfig => ({
    codec: 'vp09.00.10.08',
    codedWidth: 16,
    codedHeight: 16,
    colorSpace: colorSpace as VideoColorSpaceInit,
})
const delta = () => new Uint8Array([0x86, 0x49, 0x83, 0x42, 0x50, 0])

/** Runs frames through one track's colour and muxes them, as an export does. */
const exported = async (
    frames: { data: Uint8Array<ArrayBuffer>; type?: EncodedVideoChunkType }[],
    colorSpace: unknown,
    measured?: Parameters<typeof createVp9Color>[0],
) => {
    const color = createVp9Color(measured)
    const inputs: MuxInput[] = frames.map(({ data, type = 'key' }, i) => ({
        track: 'video',
        packet: { type, timestamp: i * 33333, duration: 33333, data },
        decoderConfig: color(data, type, i === 0 ? config(colorSpace) : undefined),
    }))
    const file = await muxVideo('webm', inputs)
    const first = inputs[0]
    return {
        colorSpace: first?.track === 'video' ? first.decoderConfig?.colorSpace : undefined,
        colour: webmColour(file),
        packets: await muxedPackets(file),
    }
}

test('a report that conflicts with the VP9 header keeps the header', async () => {
    // BT.709 and limited range, while the encoder reports full range.
    const result = await exported([{ data: vp9KeyFrame(2, 0) }], report)
    assert.deepEqual(result.colorSpace, { primaries: 'bt709', transfer: 'bt709', fullRange: false })
    // Matroska range 1 is limited; matrix 2 is unspecified, so the header alone declares it.
    assert.deepEqual(result.colour, { matrix: 2, range: 1, transfer: 1, primaries: 1 })
    assert.deepEqual(result.packets, [vp9KeyFrame(2, 0)])
})

test('a measured conversion rewrites matrix and range in every key frame', async () => {
    const result = await exported(
        [
            { data: vp9KeyFrame(2, 1) },
            { data: delta(), type: 'delta' },
            { data: vp9KeyFrame(1, 1) },
        ],
        report,
        { matrix: 'smpte170m', fullRange: false },
    )
    assert.deepEqual(result.colour, { matrix: 2, range: 1, transfer: 1, primaries: 1 })
    assert.deepEqual(
        result.packets.map((packet) => vp9Fields(packet)),
        [{ space: 3, range: 0 }, vp9Fields(delta()), { space: 3, range: 0 }],
    )
    // Profile, frame type, sync code and frame size are untouched.
    const original = vp9KeyFrame(2, 1)
    const patched = result.packets[0]!
    assert.deepEqual(patched.subarray(0, 4), original.subarray(0, 4))
    assert.equal(patched[4]! & 15, original[4]! & 15)
    assert.deepEqual(patched.subarray(5), original.subarray(5))
    assert.deepEqual(result.packets[1], delta())
})

test('a measurement that agrees with the report still overrides the header', async () => {
    const agreeing = await exported([{ data: vp9KeyFrame(3, 0) }], report, {
        matrix: 'bt709',
        fullRange: true,
    })
    assert.deepEqual(agreeing.packets.map(vp9Fields), [{ space: 2, range: 1 }])
    assert.equal(agreeing.colour?.range, 2)
    // CS_BT_601 already has the measured BT.601 coefficients.
    const bt601 = await exported([{ data: vp9KeyFrame(1, 0) }], report, {
        matrix: 'smpte170m',
        fullRange: false,
    })
    assert.deepEqual(bt601.packets, [vp9KeyFrame(1, 0)])
})

test('an unknown header matrix is filled from the report', async () => {
    const filled = await exported([{ data: vp9KeyFrame(0, 1) }], { ...report, matrix: 'smpte170m' })
    assert.deepEqual(filled.packets.map(vp9Fields), [{ space: 3, range: 1 }])
    assert.deepEqual(filled.colour, { matrix: 2, range: 2, transfer: 1, primaries: 1 })
    // Null and unknown report values fill nothing.
    for (const colorSpace of [
        undefined,
        null,
        { matrix: 'ycgco', transfer: 'gamma22', primaries: null, fullRange: null },
    ]) {
        const unknown = await exported([{ data: vp9KeyFrame(0, 0) }], colorSpace)
        assert.deepEqual(unknown.packets, [vp9KeyFrame(0, 0)])
        assert.deepEqual(unknown.colorSpace, { fullRange: false })
        assert.deepEqual(unknown.colour, { matrix: 2, range: 1, transfer: 2, primaries: 2 })
    }
})

test('frames that cannot be patched pass unchanged and an unread first frame declares no colour', async () => {
    const unread = [
        new Uint8Array([0x82, 0]), // truncated
        new Uint8Array([0x82, 0x49, 0x83, 0x43, 0x40, 0]), // wrong sync code
        new Uint8Array([0x8a, 0]), // show_existing_frame
        new Uint8Array([0xa2, 0x49, 0x83, 0x42, 0xe0, 0, 0, 0]), // profile 1 RGB
        new Uint8Array([0x92, 0x49, 0x83, 0x42, 0x20, 0]), // profile 2
        new Uint8Array([0x82, 0x49, 0x83, 0x42, 0xe0, 0]), // CS_RGB in profile 0
    ]
    for (const frame of unread) {
        const copy = new Uint8Array(frame)
        // A readable later key frame stays as written too.
        const result = await exported([{ data: frame }, { data: vp9KeyFrame(2, 1) }], report, {
            matrix: 'smpte170m',
            fullRange: false,
        })
        assert.equal(result.colorSpace, undefined)
        assert.equal(result.colour, undefined)
        assert.deepEqual(result.packets, [copy, vp9KeyFrame(2, 1)])
    }
    // A later key frame that cannot be read keeps its bytes.
    const later = await exported(
        [{ data: vp9KeyFrame(2, 1) }, { data: new Uint8Array([0x92, 0x49, 0x83, 0x42, 0x20, 0]) }],
        report,
        { matrix: 'smpte170m', fullRange: false },
    )
    assert.deepEqual(later.packets[1], new Uint8Array([0x92, 0x49, 0x83, 0x42, 0x20, 0]))
})
