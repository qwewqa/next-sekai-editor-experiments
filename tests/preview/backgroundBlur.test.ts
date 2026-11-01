import assert from 'node:assert/strict'
import test from 'node:test'
import { backgroundBlurSize, backgroundColor } from '../../src/preview/backgroundBlur'

test('blur stays within two 2048-square textures and eight working pixels of sigma', () => {
    for (const height of [720, 1080, 2160, 4320])
        for (const aspect of [4 / 3, 16 / 9, 21 / 9])
            for (const blur of [0.1, 1, 6, 100]) {
                const size = backgroundBlurSize(height * aspect, height, (blur * height) / 540)
                assert.ok(size.width <= 2048 && size.height <= 2048)
                assert.ok(size.sigma <= 8)
                assert.ok(size.width * size.height * 4 * 2 <= 32 * 1024 * 1024)
            }
})

test('background colours keep premultiplied alpha, including short hex colours', () => {
    assert.deepEqual(backgroundColor('transparent'), [0, 0, 0, 0])
    assert.deepEqual(backgroundColor('#f008'), [136 / 255, 0, 0, 136 / 255])
    assert.deepEqual(backgroundColor('#ffffff'), [1, 1, 1, 1])
})
