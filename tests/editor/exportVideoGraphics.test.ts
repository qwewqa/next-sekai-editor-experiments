import assert from 'node:assert/strict'
import test from 'node:test'
import { outputSize } from '../../src/exportVideo/codecs'
import { fitsGraphicsLimits } from '../../src/exportVideo/graphics'

test('4K at 2x fits at the GPU maximum with antialiasing', () => {
    assert.deepEqual(outputSize(720, 21 / 9), { width: 1680, height: 720 })
    assert.equal(outputSize(721, 16 / 9).width % 2, 0)
    const size = outputSize(2160, 16 / 9)
    const limits = { viewport: [7680, 4320] as const, renderbuffer: 7680, texture: 7680 }
    assert.equal(fitsGraphicsLimits(size, 2, true, limits), true)
    for (const patch of [
        { viewport: [7679, 4320] as const },
        { viewport: [7680, 4319] as const },
        { renderbuffer: 7679 },
        { texture: 7679 },
    ]) {
        assert.equal(fitsGraphicsLimits(size, 2, true, { ...limits, ...patch }), false)
    }
    // Without antialiasing, only the output canvas needs a renderbuffer of this size.
    assert.equal(fitsGraphicsLimits(size, 2, false, { ...limits, renderbuffer: 3840 }), true)
    assert.equal(fitsGraphicsLimits(size, 2, false, { ...limits, renderbuffer: 3839 }), false)
})
