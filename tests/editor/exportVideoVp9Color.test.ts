import assert from 'node:assert/strict'
import test from 'node:test'
import { createVp9Color } from '../../src/exportVideo/worker/vp9Color'
import { muxOne, vp9Fields, vp9KeyFrame, webmColour, webmFrame } from './videoColorFixtures'

const report: VideoColorSpaceInit = {
    primaries: 'bt709',
    transfer: 'bt709',
    matrix: 'bt709',
    fullRange: true,
}
const config = (colorSpace: unknown = report): VideoDecoderConfig => ({
    codec: 'vp09.00.10.08',
    codedWidth: 16,
    codedHeight: 16,
    colorSpace: colorSpace as VideoColorSpaceInit,
})
const webm = async (
    data: Uint8Array<ArrayBuffer>,
    decoderConfig: VideoDecoderConfig | undefined,
) => {
    const file = await muxOne('webm', {
        track: 'video',
        packet: { type: 'key', timestamp: 0, duration: 33333, data },
        decoderConfig,
    })
    return { colour: webmColour(file), frame: vp9Fields(webmFrame(file)) }
}

test('a report that conflicts with the VP9 header keeps the header, and the container matches it', async () => {
    // BT.709, limited range, while the encoder reports full range.
    const frame = vp9KeyFrame(2, 0)
    const result = createVp9Color()(frame, 'key', config())
    assert.deepEqual(frame, vp9KeyFrame(2, 0))
    assert.deepEqual(result?.colorSpace, { ...report, fullRange: false })
    // Matroska range 1 is broadcast (limited) range.
    assert.deepEqual(await webm(frame, result), {
        colour: { matrix: 1, range: 1, transfer: 1, primaries: 1 },
        frame: { space: 2, range: 0 },
    })
})

test('a measured conversion rewrites matrix and range in the header and the container', async () => {
    const frame = vp9KeyFrame(2, 1)
    const result = createVp9Color({ matrix: 'smpte170m', fullRange: false })(frame, 'key', config())
    assert.deepEqual(vp9Fields(frame), { space: 3, range: 0 })
    // Profile, frame type, sync code and frame size are untouched.
    assert.deepEqual(frame.subarray(0, 4), vp9KeyFrame(2, 1).subarray(0, 4))
    assert.equal(frame[4]! & 15, vp9KeyFrame(2, 1)[4]! & 15)
    assert.deepEqual(frame.subarray(5), vp9KeyFrame(2, 1).subarray(5))
    assert.deepEqual(result?.colorSpace, { ...report, matrix: 'smpte170m', fullRange: false })
    assert.deepEqual(await webm(frame, result), {
        colour: { matrix: 6, range: 1, transfer: 1, primaries: 1 },
        frame: { space: 3, range: 0 },
    })
    // A measurement that agrees with the report still overrides the header.
    const agreeing = vp9KeyFrame(3, 0)
    const full = createVp9Color({ matrix: 'bt709', fullRange: true })(agreeing, 'key', config())
    assert.deepEqual(vp9Fields(agreeing), { space: 2, range: 1 })
    assert.deepEqual(full?.colorSpace, report)
    // CS_BT_601 already has the measured BT.601 coefficients.
    const bt601 = vp9KeyFrame(1, 0)
    const same = createVp9Color({ matrix: 'smpte170m', fullRange: false })(bt601, 'key', config())
    assert.deepEqual(vp9Fields(bt601), { space: 1, range: 0 })
    assert.equal(same?.colorSpace?.matrix, 'bt470bg')
})

test('an unknown header matrix is filled from the report', async () => {
    const frame = vp9KeyFrame(0, 1)
    const result = createVp9Color()(frame, 'key', config({ ...report, matrix: 'smpte170m' }))
    assert.deepEqual(vp9Fields(frame), { space: 3, range: 1 })
    assert.deepEqual(await webm(frame, result), {
        colour: { matrix: 6, range: 2, transfer: 1, primaries: 1 },
        frame: { space: 3, range: 1 },
    })
    const unknown = vp9KeyFrame(0, 0)
    const none = createVp9Color()(unknown, 'key', config({ matrix: 'ycgco', fullRange: null }))
    assert.deepEqual(unknown, vp9KeyFrame(0, 0))
    assert.deepEqual(none?.colorSpace, { fullRange: false })
})

test('later key frames take the track colour and other frames pass unchanged', () => {
    const color = createVp9Color({ matrix: 'smpte170m', fullRange: false })
    const first = vp9KeyFrame(2, 1)
    const decoderConfig = color(first, 'key', config())
    const later = vp9KeyFrame(2, 1)
    const delta = new Uint8Array([0x86, 0x49, 0x83, 0x42, 0x50, 0])
    assert.equal(color(later, 'key'), undefined)
    assert.equal(color(delta, 'delta'), undefined)
    assert.deepEqual(vp9Fields(later), { space: 3, range: 0 })
    assert.deepEqual(delta, new Uint8Array([0x86, 0x49, 0x83, 0x42, 0x50, 0]))
    // A repeated configuration keeps the first colour.
    assert.deepEqual(color(vp9KeyFrame(2, 1), 'key', config({ ...report, matrix: 'bt470bg' })), {
        ...config(),
        colorSpace: decoderConfig?.colorSpace,
    })
})

test('VP9 frames that cannot be read pass unchanged with the normalized report', async () => {
    const frames = [
        new Uint8Array([0x82, 0]), // truncated
        new Uint8Array([0x82, 0x49, 0x83, 0x43, 0x40, 0]), // wrong sync code
        new Uint8Array([0x42, 0x49, 0x83, 0x42, 0x40, 0]), // wrong frame marker
        new Uint8Array([0x8a, 0]), // show_existing_frame
    ]
    for (const frame of frames) {
        const copy = new Uint8Array(frame)
        const result = createVp9Color()(frame, 'key', config({ ...report, transfer: 'gamma22' }))
        assert.deepEqual(frame, copy)
        assert.deepEqual(result?.colorSpace, {
            primaries: 'bt709',
            matrix: 'bt709',
            fullRange: true,
        })
    }
    // After an unread first frame, a measurement is not written and later key frames stay.
    const color = createVp9Color({ matrix: 'smpte170m', fullRange: false })
    const first = color(new Uint8Array([0x82, 0]), 'key', config())
    const later = vp9KeyFrame(2, 1)
    color(later, 'key')
    assert.deepEqual(first?.colorSpace, report)
    assert.deepEqual(later, vp9KeyFrame(2, 1))
    // Profile 1 RGB has no range bit; its matrix stays undeclared and the bytes stay.
    const rgb = new Uint8Array([0xa2, 0x49, 0x83, 0x42, 0xe0, 0, 0, 0])
    const result = createVp9Color({ matrix: 'bt709', fullRange: false })(rgb, 'key', config())
    assert.deepEqual(rgb, new Uint8Array([0xa2, 0x49, 0x83, 0x42, 0xe0, 0, 0, 0]))
    assert.deepEqual(result?.colorSpace, { primaries: 'bt709', transfer: 'bt709', fullRange: true })
})

test('profile 2 headers are rewritten after the bit depth flag', () => {
    // Profile 2, then ten_or_twelve_bit 0, color_space BT.709, color_range 0.
    const frame = new Uint8Array([0x92, 0x49, 0x83, 0x42, 0x20, 0])
    createVp9Color({ matrix: 'smpte170m', fullRange: true })(frame, 'key', config())
    assert.deepEqual(frame, new Uint8Array([0x92, 0x49, 0x83, 0x42, 0x38, 0]))
})
