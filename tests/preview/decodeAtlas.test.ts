import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeAtlas, decodeSize } from '../../src/preview/decodeAtlas'

test('an atlas within the limit keeps its size; a larger one halves until it fits', () => {
    assert.deepEqual(decodeSize(4096, 4096, 4096), { width: 4096, height: 4096 })
    assert.deepEqual(decodeSize(1024, 512, 4096), { width: 1024, height: 512 })
    assert.deepEqual(decodeSize(4096, 4096, 2048), { width: 2048, height: 2048 })
    assert.deepEqual(decodeSize(4096, 2048, 1024), { width: 1024, height: 512 })
    assert.deepEqual(decodeSize(4096, 4096, 3000), { width: 2048, height: 2048 })
    assert.deepEqual(decodeSize(3001, 100, 2048), { width: 1500, height: 50 })
})

// The header of a PNG of the given size; the decoder is mocked, so nothing past it is read.
const png = (width: number, height: number) => {
    const bytes = new Uint8Array(24)
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
    const view = new DataView(bytes.buffer)
    view.setUint32(16, width)
    view.setUint32(20, height)
    return bytes
}

type Options = ImageBitmapOptions | undefined
const fakeBitmap = (width: number, height: number) => ({ width, height, close() {} })

// Node has no createImageBitmap or OffscreenCanvas: set them for one test.
const stub = (t: test.TestContext, name: string, value: unknown) => {
    const globals = globalThis as Record<string, unknown>
    const before = globals[name]
    globals[name] = value
    t.after(() => {
        globals[name] = before
    })
}

test('an atlas over the limit decodes at the smaller size with a 2x2 filter', async (t) => {
    const calls: Options[] = []
    stub(t, 'createImageBitmap', async (_: unknown, options: Options) => {
        calls.push(options)
        return fakeBitmap(options?.resizeWidth ?? 4096, options?.resizeHeight ?? 4096)
    })
    const small = await decodeAtlas(png(4096, 4096), 4096)
    assert.equal(small.width, 4096)
    assert.equal(calls[0]?.resizeWidth, undefined)
    const scaled = await decodeAtlas(png(4096, 4096), 2048)
    assert.equal(scaled.width, 2048)
    assert.equal(calls[1]?.resizeWidth, 2048)
    assert.equal(calls[1]?.resizeHeight, 2048)
    assert.equal(calls[1]?.resizeQuality, 'medium')
    assert.equal(calls[1]?.premultiplyAlpha, 'premultiply')
})

test('a browser that ignores the resize options gets the atlas scaled on a canvas', async (t) => {
    const drawn: number[][] = []
    let closed = 0
    stub(t, 'createImageBitmap', async (source: unknown) =>
        source instanceof Blob
            ? { ...fakeBitmap(4096, 4096), close: () => closed++ }
            : fakeBitmap(
                  (source as { width: number }).width,
                  (source as { height: number }).height,
              ),
    )
    class FakeCanvas {
        constructor(
            public width: number,
            public height: number,
        ) {}
        getContext() {
            return {
                drawImage: (_: unknown, x: number, y: number, w: number, h: number) =>
                    drawn.push([x, y, w, h]),
            }
        }
    }
    stub(t, 'OffscreenCanvas', FakeCanvas)
    const scaled = await decodeAtlas(png(4096, 4096), 2048)
    assert.equal(scaled.width, 2048)
    assert.deepEqual(drawn, [[0, 0, 2048, 2048]])
    assert.equal(closed, 1)
})
