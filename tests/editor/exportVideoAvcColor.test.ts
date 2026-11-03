import assert from 'node:assert/strict'
import test from 'node:test'
import { withAvcColor } from '../../src/exportVideo/worker/avcColor'
import { mp4AvcC, mp4Colr, muxVideo, spsColors } from './videoColorFixtures'

// Chromium's H.264 encoder includes timing and restrictions but no video_signal_type.
const original = new Uint8Array([
    1, 100, 0, 30, 255, 225, 0, 23, 103, 100, 0, 30, 172, 43, 64, 160, 207, 207, 128, 136, 0, 0, 31,
    64, 0, 7, 83, 0, 120, 225, 53, 1, 0, 4, 104, 238, 60, 176, 253, 248, 248, 0,
])
// The same SPS declaring BT.709 primaries, sRGB transfer, BT.709 matrix and full range.
const expected = new Uint8Array([
    1, 100, 0, 30, 255, 225, 0, 27, 103, 100, 0, 30, 172, 43, 64, 160, 207, 207, 128, 183, 1, 13, 1,
    64, 0, 0, 250, 0, 0, 58, 152, 3, 199, 9, 168, 1, 0, 4, 104, 238, 60, 176, 253, 248, 248, 0,
])
// Baseline, 16x16, one reference, no cropping and no VUI.
const withoutVui = new Uint8Array([1, 66, 0, 10, 255, 225, 0, 6, 103, 66, 0, 10, 244, 242, 0])
const declared = { primaries: 1, transfer: 13, matrix: 1, range: 1 }
const colorSpace: VideoColorSpaceInit = {
    primaries: 'bt709',
    transfer: 'iec61966-2-1',
    matrix: 'bt709',
    fullRange: true,
}
const config = (
    description: AllowSharedBufferSource | undefined,
    color: unknown = colorSpace,
): VideoDecoderConfig => ({
    codec: 'avc1.64001e',
    codedWidth: 16,
    codedHeight: 16,
    colorSpace: color as VideoColorSpaceInit,
    description,
})
const bytesOf = (config: VideoDecoderConfig) => config.description as Uint8Array
const mp4 = (decoderConfig: VideoDecoderConfig) =>
    muxVideo('mp4', [
        {
            track: 'video',
            packet: {
                type: 'key',
                timestamp: 0,
                duration: 33333,
                data: new Uint8Array([0, 0, 0, 1, 101]),
            },
            decoderConfig,
        },
    ])

test('adding colour fields preserves SPS timing, restrictions, PPS and profile extensions', () => {
    const bytes = new Uint8Array(original.length + 4)
    bytes.set(original, 2)
    const result = withAvcColor(config(bytes.subarray(2, -2)))
    assert.deepEqual(result.description, expected)
    assert.deepEqual(result.colorSpace, colorSpace)
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
    const result = withAvcColor({ ...config(withoutVui), codec: 'avc1.42000a' })
    assert.deepEqual(
        result.description,
        new Uint8Array([
            1, 66, 0, 10, 255, 225, 0, 11, 103, 66, 0, 10, 244, 244, 220, 4, 52, 4, 8, 0,
        ]),
    )
    assert.deepEqual(spsColors(bytesOf(result)), [declared])
    assert.deepEqual(withAvcColor(result), result)
})

test('a report that conflicts with the SPS keeps the SPS, and the container matches it', async () => {
    for (const patch of [
        { fullRange: false },
        { primaries: 'smpte170m' },
        { transfer: 'bt709' },
        { matrix: 'smpte170m' },
    ] as const) {
        const result = withAvcColor(config(expected, { ...colorSpace, ...patch }))
        assert.equal(result.description, expected)
        assert.deepEqual(result.colorSpace, colorSpace)
        const file = await mp4(result)
        assert.deepEqual(mp4Colr(file), declared)
        assert.deepEqual(mp4AvcC(file), expected)
    }
})

test('a measurement corrects the SPS matrix and range, even when the report agrees with it', async () => {
    const report = { ...colorSpace, matrix: 'smpte170m', fullRange: false }
    const result = withAvcColor(config(expected, report), { matrix: 'smpte170m', fullRange: false })
    const written = { ...declared, matrix: 6, range: 0 }
    assert.equal(bytesOf(result).length, expected.length)
    assert.deepEqual(spsColors(bytesOf(result)), [written])
    assert.deepEqual(bytesOf(result).subarray(-11), expected.subarray(-11))
    assert.deepEqual(result.colorSpace, report)
    assert.deepEqual(withAvcColor(result), result)
    assert.deepEqual(mp4Colr(await mp4(result)), written)
    // Primaries and transfer stay as the SPS declares them.
    const other = withAvcColor(config(expected, { ...report, primaries: 'smpte170m' }), {
        matrix: 'bt709',
        fullRange: false,
    })
    assert.deepEqual(spsColors(bytesOf(other)), [{ ...declared, range: 0 }])
    // BT.470BG has the BT.601 coefficients, so it already matches a measured SMPTE 170M.
    const bt470bg = withAvcColor(config(expected, { ...colorSpace, matrix: 'bt470bg' }), {
        matrix: 'bt709',
        fullRange: true,
    })
    const declared470 = withAvcColor(
        config(bytesOf(withAvcColor(config(original, { ...colorSpace, matrix: 'bt470bg' })))),
        { matrix: 'smpte170m', fullRange: true },
    )
    assert.equal(bt470bg.description, expected)
    assert.deepEqual(spsColors(bytesOf(declared470)), [{ ...declared, matrix: 5 }])
    assert.equal(declared470.colorSpace?.matrix, 'bt470bg')
})

test('absent, null, partial and unknown colour never fails', async () => {
    const unknown = { primaries: 'film', transfer: 'gamma22', matrix: 'ycgco', fullRange: 'yes' }
    for (const color of [undefined, null, unknown, { primaries: null, fullRange: null }]) {
        // Nothing to fill: the bytes stay and the container declares nothing new.
        const plain = withAvcColor({
            ...config(original),
            colorSpace: color as VideoColorSpaceInit,
        })
        assert.equal(plain.description, original)
        assert.equal(plain.colorSpace, undefined)
        assert.equal(mp4Colr(await mp4(plain)), undefined)
        const vui = withAvcColor({ ...config(expected), colorSpace: color as VideoColorSpaceInit })
        assert.equal(vui.description, expected)
        assert.deepEqual(vui.colorSpace, colorSpace)
        const bare = withAvcColor({
            ...config(withoutVui),
            colorSpace: color as VideoColorSpaceInit,
        })
        assert.equal(bare.description, withoutVui)
    }
    const partial = withAvcColor(config(original, { matrix: 'bt709', fullRange: null }))
    assert.deepEqual(spsColors(bytesOf(partial)), [
        { primaries: 2, transfer: 2, matrix: 1, range: 0 },
    ])
    assert.deepEqual(partial.colorSpace, { matrix: 'bt709', fullRange: false })
    assert.deepEqual(mp4Colr(await mp4(partial)), {
        primaries: 2,
        transfer: 2,
        matrix: 1,
        range: 0,
    })
    // Without a description there is no SPS to describe.
    const reported = withAvcColor(config(undefined, { ...unknown, matrix: 'bt709' }))
    assert.equal(reported.description, undefined)
    assert.equal(reported.colorSpace, undefined)
})

test('a description that cannot be read or rewritten passes unchanged and declares no colour', async () => {
    const sps = (bytes: number[]) =>
        new Uint8Array([1, 100, 0, 30, 255, 225, 0, bytes.length, ...bytes, 0])
    const fitted = new Uint8Array(6 + 2 + 65535 + 1)
    fitted.set([1, 66, 0, 10, 255, 225, 255, 255, 103, 66, 0, 10, 244, 242])
    // Bits after the stop bit keep the patched SPS from shrinking.
    fitted.fill(255, 14, -1)
    const cases = [
        original.subarray(0, 15), // SPS longer than the description
        original.subarray(0, 7), // truncated length
        new Uint8Array([2, ...original.subarray(1)]), // unknown avcC version
        new Uint8Array([...original.subarray(0, 5), 224, ...original.subarray(6)]), // no SPS
        sps([103, 100, 0, 30, 172, 43]), // truncated Exp-Golomb value
        sps([103, 100, 0, 30, 0, 0, 0, 0, 1]), // Exp-Golomb value over 32 bits
        sps([104, 100, 0, 30, 172, 43, 64, 160]), // not an SPS
        sps([103, 66, 0, 10, 244, 240]), // no rbsp_stop_one_bit
        new Uint8Array([
            ...original.subarray(0, 5),
            226,
            ...original.subarray(6, 31),
            0,
            6,
            103,
            100,
            0,
            30,
            172,
            43,
            ...original.subarray(31),
        ]), // two SPS, the second truncated
    ]
    const report = { ...colorSpace, matrix: 'smpte170m', unknown: 1 }
    for (const description of cases) {
        const copy = new Uint8Array(description)
        const result = withAvcColor(config(description, report), {
            matrix: 'bt709',
            fullRange: false,
        })
        assert.equal(result.description, description)
        assert.deepEqual(description, copy)
        assert.equal(result.colorSpace, undefined)
        const file = await mp4(result)
        assert.equal(mp4Colr(file), undefined)
        assert.deepEqual(mp4AvcC(file), copy)
    }
    // An SPS that can be read but not rewritten states its own colour, here none.
    const copy = new Uint8Array(fitted)
    const unfitted = withAvcColor(config(fitted, report), { matrix: 'bt709', fullRange: true })
    assert.equal(unfitted.description, fitted)
    assert.deepEqual(fitted, copy)
    assert.equal(unfitted.colorSpace, undefined)
})
