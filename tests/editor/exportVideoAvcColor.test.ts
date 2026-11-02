import assert from 'node:assert/strict'
import test from 'node:test'
import { withAvcColor } from '../../src/exportVideo/worker/avcColor'

// Chromium's H.264 encoder includes timing and restrictions but no video_signal_type.
const original = new Uint8Array([
    1, 100, 0, 30, 255, 225, 0, 23, 103, 100, 0, 30, 172, 43, 64, 160, 207, 207, 128, 136, 0, 0, 31,
    64, 0, 7, 83, 0, 120, 225, 53, 1, 0, 4, 104, 238, 60, 176, 253, 248, 248, 0,
])
const expected = new Uint8Array([
    1, 100, 0, 30, 255, 225, 0, 27, 103, 100, 0, 30, 172, 43, 64, 160, 207, 207, 128, 183, 1, 13, 1,
    64, 0, 0, 250, 0, 0, 58, 152, 3, 199, 9, 168, 1, 0, 4, 104, 238, 60, 176, 253, 248, 248, 0,
])
const colorSpace: VideoColorSpaceInit = {
    primaries: 'bt709',
    transfer: 'iec61966-2-1',
    matrix: 'bt709',
    fullRange: true,
}
const config = (description: AllowSharedBufferSource): VideoDecoderConfig => ({
    codec: 'avc1.64001e',
    colorSpace,
    description,
})

test('adding colour fields preserves SPS timing, restrictions, PPS and profile extensions', () => {
    const bytes = new Uint8Array(original.length + 4)
    bytes.set(original, 2)
    const result = withAvcColor(config(bytes.subarray(2, -2)))
    assert.deepEqual(result.description, expected)
    assert.equal(result.colorSpace, colorSpace)
    assert.deepEqual(bytes.subarray(2, -2), original)
    assert.deepEqual(withAvcColor(result), result)
})

test('every SPS receives colour fields', () => {
    const multiple = new Uint8Array([
        ...original.subarray(0, 5),
        226,
        ...original.subarray(6, 31),
        ...original.subarray(6),
    ])
    const result = withAvcColor(config(multiple)).description
    assert.deepEqual(
        result,
        new Uint8Array([
            ...expected.subarray(0, 5),
            226,
            ...expected.subarray(6, 35),
            ...expected.subarray(6),
        ]),
    )
})

test('an SPS without VUI receives colour fields and retains its stop bit', () => {
    // Baseline, 16x16, one reference, no cropping and no VUI.
    const withoutVui = new Uint8Array([1, 66, 0, 10, 255, 225, 0, 6, 103, 66, 0, 10, 244, 242, 0])
    const result = withAvcColor({ ...config(withoutVui), codec: 'avc1.42000a' })
    assert.deepEqual(
        result.description,
        new Uint8Array([
            1, 66, 0, 10, 255, 225, 0, 11, 103, 66, 0, 10, 244, 244, 220, 4, 52, 4, 8, 0,
        ]),
    )
    assert.deepEqual(withAvcColor(result), result)
})

test('conflicting declarations and incomplete colour metadata fail instead of guessing', () => {
    for (const patch of [{ fullRange: false }, { matrix: 'smpte170m' }] as const)
        assert.throws(
            () => withAvcColor({ ...config(expected), colorSpace: { ...colorSpace, ...patch } }),
            /Conflicting/,
        )
    assert.throws(() => withAvcColor({ ...config(original), colorSpace: undefined }), /missing/)
    assert.throws(() => withAvcColor(config(original.subarray(0, 15))), /Invalid/)
    const truncatedSps = new Uint8Array([1, 100, 0, 30, 255, 225, 0, 1, 103])
    assert.throws(() => withAvcColor(config(truncatedSps)), /Truncated/)
})

test('a measured conversion overwrites the colour that the SPS states', () => {
    const measured = { ...colorSpace, matrix: 'smpte170m', fullRange: false } as const
    const result = withAvcColor({ ...config(expected), colorSpace: measured }, true)
    assert.equal((result.description as Uint8Array).length, expected.length)
    assert.deepEqual(withAvcColor(result), result)
    assert.throws(() => withAvcColor({ ...result, colorSpace }), /Conflicting/)
})

test('VP9 configuration passes through unchanged', () => {
    const vp9 = { codec: 'vp09.00.20.08', colorSpace }
    assert.equal(withAvcColor(vp9), vp9)
})
