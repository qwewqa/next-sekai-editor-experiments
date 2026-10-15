import assert from 'node:assert/strict'
import test from 'node:test'
import type { Quad } from '../../src/preview/engine/math'
import { BlendMode, createPreviewRenderer, type BlendModeValue } from '../../src/preview/gl'
import type { Sprite } from '../../src/preview/skin'

const sprite: Sprite = { u0: 0.1, v0: 0.2, u1: 0.7, v1: 0.8 }
const quad: Quad = {
    bl: { x: -2, y: -1 },
    tl: { x: -1, y: 1 },
    tr: { x: 1, y: 1 },
    br: { x: 2, y: -1 },
}

const createFixture = (
    failure?: 'compile' | 'link' | 'buffer' | 'texture',
    deleted: string[] = [],
) => {
    const allocations: number[] = []
    const uploads: { data: Float32Array; buffer: ArrayBufferLike }[] = []
    const draws: { first: number; count: number; additive: boolean }[] = []
    let additive = false
    let clears = 0
    let textureCount = 0
    let currentProgram: unknown
    const noop = () => {}
    const gl = {
        MAX_VIEWPORT_DIMS: 0x0d3a,
        ARRAY_BUFFER: 0x8892,
        DYNAMIC_DRAW: 0x88e8,
        TRIANGLES: 4,
        ONE: 1,
        ONE_MINUS_SRC_ALPHA: 0x0303,
        getParameter: () => new Int32Array([4096, 8192]),
        createShader: () => ({}),
        shaderSource: noop,
        compileShader: noop,
        getShaderParameter: () => failure !== 'compile',
        getShaderInfoLog: () => 'fixture compile error',
        deleteShader: () => deleted.push('shader'),
        createProgram: () => ({}),
        attachShader: noop,
        linkProgram: noop,
        getProgramParameter: () => failure !== 'link',
        getProgramInfoLog: () => 'fixture link error',
        detachShader: noop,
        deleteProgram: (program: unknown) => {
            assert.notEqual(
                program,
                currentProgram,
                'unbind a deleted program so WebGL releases it',
            )
            deleted.push('program')
        },
        useProgram: (program: unknown) => {
            currentProgram = program
        },
        getAttribLocation: () => 0,
        getUniformLocation: () => ({}),
        uniform1i: noop,
        uniform1f: noop,
        createBuffer: () => (failure === 'buffer' ? null : {}),
        deleteBuffer: () => deleted.push('buffer'),
        bindBuffer: noop,
        enableVertexAttribArray: noop,
        vertexAttribPointer: noop,
        enable: noop,
        blendFunc: noop,
        clearColor: noop,
        createTexture: () => (failure === 'texture' && textureCount++ === 1 ? null : {}),
        deleteTexture: () => deleted.push('texture'),
        getExtension: () => null,
        isContextLost: () => false,
        activeTexture: noop,
        bindTexture: noop,
        texParameteri: noop,
        pixelStorei: noop,
        texImage2D: noop,
        viewport: noop,
        clear: () => clears++,
        bufferData: (target: number, size: number, usage: number) => {
            assert.equal(target, gl.ARRAY_BUFFER)
            assert.equal(usage, gl.DYNAMIC_DRAW)
            assert.equal(typeof size, 'number')
            allocations.push(size)
        },
        bufferSubData: (target: number, offset: number, data: Float32Array) => {
            assert.equal(target, gl.ARRAY_BUFFER)
            assert.equal(offset, 0)
            assert.ok(data.byteLength <= allocations.at(-1)!)
            uploads.push({ data: data.slice(), buffer: data.buffer })
        },
        blendFuncSeparate: (src: number, dst: number, srcAlpha: number, dstAlpha: number) => {
            assert.equal(src, gl.ONE)
            assert.equal(srcAlpha, gl.ONE)
            assert.equal(dstAlpha, gl.ONE_MINUS_SRC_ALPHA)
            additive = dst === gl.ONE
        },
        drawArrays: (mode: number, first: number, count: number) => {
            assert.equal(mode, gl.TRIANGLES)
            draws.push({ first, count, additive })
        },
    }
    const canvas = {
        width: 0,
        height: 0,
        getContext: (kind: string) => {
            assert.equal(kind, 'webgl2')
            return gl
        },
    }
    const renderer = createPreviewRenderer(canvas as unknown as HTMLCanvasElement)
    renderer.setTexture(0, {} as ImageBitmap, true)
    return { renderer, canvas, allocations, uploads, draws, deleted, clears: () => clears }
}

test('preview requires WebGL2 and only retries its antialias option', () => {
    for (const antialias of [true, false]) {
        const requests: { kind: string; antialias: boolean }[] = []
        const canvas = {
            getContext: (kind: string, options: WebGLContextAttributes) => {
                requests.push({ kind, antialias: !!options.antialias })
                // A legacy context is available, but is outside the renderer contract.
                return kind === 'webgl' ? {} : null
            },
        }
        assert.throws(
            () => createPreviewRenderer(canvas as unknown as HTMLCanvasElement, antialias),
            /WebGL2 is unavailable or disabled in this browser/,
        )
        assert.deepEqual(
            requests,
            (antialias ? [true, false] : [false]).map((value) => ({
                kind: 'webgl2',
                antialias: value,
            })),
        )
    }
})

test('renderer explicitly releases resources once even without context-loss support', () => {
    const { renderer, deleted, clears, canvas } = createFixture()
    assert.deepEqual(deleted, ['shader', 'shader'])
    renderer.begin(1280, 720)
    renderer.draw(sprite, quad, [0], 1)
    renderer.flush()
    renderer.dispose()
    renderer.dispose()
    assert.deepEqual(deleted.sort(), [
        'buffer',
        'program',
        'shader',
        'shader',
        'texture',
        'texture',
    ])
    assert.equal(renderer.isContextLost(), true)
    renderer.begin(320, 200)
    renderer.draw(sprite, quad, [0], 1)
    renderer.flush()
    assert.equal(canvas.width, 1280)
    assert.equal(clears(), 1)
})

test('failed shader compilation, linking and allocation release partially created resources', () => {
    for (const [failure, expected, message] of [
        ['compile', ['program', 'shader'], 'fixture compile error'],
        ['link', ['program', 'shader', 'shader'], 'fixture link error'],
        ['buffer', ['program', 'shader', 'shader'], 'Failed to create preview vertex buffer'],
        [
            'texture',
            ['buffer', 'program', 'shader', 'shader', 'texture'],
            'Failed to create preview texture',
        ],
    ] as const) {
        const deleted: string[] = []
        assert.throws(() => createFixture(failure, deleted), new RegExp(message))
        assert.deepEqual(deleted.sort(), [...expected].sort())
    }
})

test('renderer preserves perspective UVs, transforms, texture selection and vertex snapshots', () => {
    const { renderer, uploads } = createFixture()
    renderer.setTexture(1, {} as ImageBitmap, false)
    renderer.begin(1600, 900)
    const transform = Array.from({ length: 64 }, (_, index) => {
        const row = Math.floor(index / 8)
        return index % 8 === row ? (row < 4 ? -2 : 0.5) : 0
    })
    const transformedSprite: Sprite = { ...sprite, texture: 1, transform }
    renderer.draw(sprite, quad, [1], 1)
    renderer.draw(transformedSprite, quad, [0], 0.4, { r: 0.2, g: 0.6, b: 0.9 })
    // Draw captures the vertices even if the caller changes its sprite before flushing.
    transformedSprite.u0 = 0.99
    transform.fill(0)
    renderer.flush()

    const expected: number[] = []
    for (const [xScale, yScale, texture, color] of [
        [-2, 0.5, 1, [0.2, 0.6, 0.9, 0.4]],
        [1, 1, 0, [1, 1, 1, 1]],
    ] as const) {
        // The diagonal intersection gives bottom weights 3 and top weights 1.5.
        for (const [x, y, u, v, weight] of [
            [-2, -1, 0.1, 0.8, 3],
            [-1, 1, 0.1, 0.2, 1.5],
            [1, 1, 0.7, 0.2, 1.5],
            [-2, -1, 0.1, 0.8, 3],
            [1, 1, 0.7, 0.2, 1.5],
            [2, -1, 0.7, 0.8, 3],
        ] as const) {
            expected.push(x * xScale, y * yScale, u * weight, v * weight, weight, texture, ...color)
        }
    }
    assert.deepEqual(uploads[0]!.data, new Float32Array(expected))
})

test('renderer keeps lexicographic depth, submission ties and contiguous blend runs across frames', () => {
    const { renderer, uploads, draws } = createFixture()
    const draw = (id: number, z: number[], blend: BlendModeValue) =>
        renderer.draw(sprite, quad, z, id / 10, undefined, blend)
    const ids = () => {
        const data = uploads.at(-1)!.data
        return Array.from({ length: data.length / 60 }, (_, i) =>
            Math.round(data[i * 60 + 9]! * 10),
        )
    }

    renderer.begin(1600, 900)
    draw(1, [1], BlendMode.normal)
    draw(2, [0, 2], BlendMode.additive)
    draw(3, [1, 0, 0], BlendMode.additive)
    draw(4, [0, 1], BlendMode.normal)
    draw(5, [1, -1], BlendMode.normal)
    draw(6, [1], BlendMode.normal)
    renderer.flush()
    assert.deepEqual(ids(), [4, 2, 5, 1, 3, 6])
    assert.deepEqual(draws, [
        { first: 0, count: 6, additive: false },
        { first: 6, count: 6, additive: true },
        { first: 12, count: 12, additive: false },
        { first: 24, count: 6, additive: true },
        { first: 30, count: 6, additive: false },
    ])

    draws.length = 0
    renderer.begin(1600, 900)
    draw(3, [1], BlendMode.normal)
    draw(4, [0], BlendMode.normal)
    draw(1, [1], BlendMode.additive)
    renderer.flush()
    assert.deepEqual(ids(), [4, 3, 1])
    assert.deepEqual(draws, [
        { first: 0, count: 12, additive: false },
        { first: 12, count: 6, additive: true },
    ])
    assert.equal(uploads[0]!.buffer, uploads[1]!.buffer)
})

test('renderer grows buffers only as needed and uploads only the active frame', () => {
    const { renderer, allocations, uploads, clears } = createFixture()
    const frame = (count: number) => {
        renderer.begin(1280, 720)
        for (let i = 0; i < count; i++) renderer.draw(sprite, quad, [-i], 1)
        renderer.flush()
        assert.equal(uploads.at(-1)!.data.length, count * 60)
    }
    frame(2)
    frame(1)
    assert.equal(allocations.length, 1)
    assert.equal(uploads[0]!.buffer, uploads[1]!.buffer)

    const capacity = allocations[0]! / (60 * Float32Array.BYTES_PER_ELEMENT)
    frame(capacity + 1)
    assert.equal(allocations.length, 2)
    assert.notEqual(uploads[1]!.buffer, uploads[2]!.buffer)
    frame(capacity + 2)
    frame(1)
    assert.equal(allocations.length, 2)
    assert.equal(uploads[2]!.buffer, uploads[4]!.buffer)

    renderer.begin(1280, 720)
    renderer.draw(undefined, quad, [0], 1)
    renderer.draw(sprite, quad, [0], 0)
    renderer.draw({ ...sprite, texture: 1 }, quad, [0], 1)
    renderer.flush()
    assert.equal(uploads.length, 5)
    assert.equal(clears(), 6)
})
