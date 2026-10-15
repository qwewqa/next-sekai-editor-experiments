import assert from 'node:assert/strict'
import test from 'node:test'
import { createWaveformTilePixels, reduceWaveformTilePixels } from '../../src/waveform/tiles'

test('waveform tiles reverse time rows and pad only after the audio endpoint', () => {
    const samples = Uint8Array.from([10, 11, 20, 21, 30, 31, 40, 41, 50, 51])
    assert.deepEqual(createWaveformTilePixels(samples, 2, 3, 0), {
        width: 2,
        height: 3,
        alpha: Uint8Array.from([30, 31, 20, 21, 10, 11]),
    })
    assert.deepEqual(createWaveformTilePixels(samples, 2, 3, 1), {
        width: 2,
        height: 3,
        alpha: Uint8Array.from([0, 0, 50, 51, 40, 41]),
    })
    assert.deepEqual([...samples], [10, 11, 20, 21, 30, 31, 40, 41, 50, 51])
})

test('peak reductions preserve attacks in either row and in an unpaired final row', () => {
    const original = { width: 2, height: 3, alpha: Uint8Array.from([255, 0, 0, 128, 64, 32]) }
    const reduced = reduceWaveformTilePixels(original)
    assert.deepEqual(reduced, {
        width: 2,
        height: 2,
        alpha: Uint8Array.from([255, 128, 64, 32]),
    })
    assert.deepEqual(reduceWaveformTilePixels(reduced), {
        width: 2,
        height: 1,
        alpha: Uint8Array.from([255, 128]),
    })
    assert.deepEqual([...original.alpha], [255, 0, 0, 128, 64, 32])
})
