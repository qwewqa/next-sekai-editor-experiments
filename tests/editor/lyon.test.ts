import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { triangulate } from '../../src/rendering/geometry'
import { initializeLyon, loadLyon, LyonTessellator } from '../../src/rendering/lyon'

const bytes = readFileSync(new URL('../../src/rendering/vendor/lyon.wasm', import.meta.url))
const compiled = new WebAssembly.Module(bytes)
const instance = () => new WebAssembly.Instance(compiled).exports
const square = [
    {
        points: [
            [0, 0],
            [4, 0],
            [4, 4],
            [0, 4],
        ] as [number, number][],
    },
]
const area = (triangles: Float64Array) => {
    let result = 0
    for (let i = 0; i < triangles.length; i += 6) {
        const [ax, ay, bx, by, cx, cy] = Array.from(triangles.subarray(i, i + 6)) as [
            number,
            number,
            number,
            number,
            number,
            number,
        ]
        result += Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2
    }
    return result
}

test('Lyon retains nonzero/evenodd holes and far-origin geometry', () => {
    const kernel = new LyonTessellator(instance())
    const sameWinding = [
        ...square,
        {
            points: [
                [1, 1],
                [3, 1],
                [3, 3],
                [1, 3],
            ] as [number, number][],
        },
    ]
    assert.equal(area(kernel.triangulate(sameWinding, 'nonzero', 64)!), 16)
    assert.equal(area(kernel.triangulate(sameWinding, 'evenodd', 64)!), 12)
    const distant = square.map(({ points }) => ({
        points: points.map(([x, y]) => [x + 2 ** 40, y - 2 ** 40] as [number, number]),
    }))
    assert.equal(area(kernel.triangulate(distant, 'nonzero', 64)!), 16)
    kernel.dispose()
})

test('one self-winding contour is rejected before its edges can overflow i16', () => {
    const native = instance()
    let reserves = 0
    const kernel = new LyonTessellator({
        ...native,
        reserve: (...args: number[]) => {
            reserves++
            return (native.reserve as CallableFunction)(...args)
        },
    })
    const points = Array.from({ length: 32768 }, (_, index) => square[0]!.points[index % 4]!)
    assert.equal(kernel.triangulate([{ points }], 'nonzero', 1), undefined)
    assert.equal(reserves, 0)
    assert.equal(
        (native.reserve as CallableFunction)(65536, 1),
        0,
        'native ABI independently refuses too many edges',
    )
    assert.equal(
        (native.reserve as CallableFunction)(2, 32768),
        0,
        'native counts allocation is bounded too',
    )
    kernel.dispose()
})

test('precision policy refuses large local extents, nonfinite coordinates and excessive snapping scale', () => {
    const kernel = new LyonTessellator(instance())
    const thin = [
        {
            points: [
                [0, 0],
                [1000000, 0],
                [1000000, 0.001],
                [0, 0.001],
            ] as [number, number][],
        },
    ]
    assert.equal(kernel.triangulate(thin, 'nonzero', 64), undefined)
    assert.equal(kernel.triangulate(square, 'nonzero', 10000), undefined)
    assert.equal(
        kernel.triangulate(
            [
                {
                    points: [
                        [Infinity, 0],
                        [1, 0],
                        [0, 1],
                    ],
                },
            ],
            'nonzero',
            1,
        ),
        undefined,
    )
    assert.equal(
        area(kernel.triangulate(square, 'nonzero', 64)!),
        16,
        'an unsupported input does not retire the healthy instance',
    )
    kernel.dispose()
})

test('independent crossing witnesses cover the precision boundary and generated intersections', () => {
    const kernel = new LyonTessellator(instance())
    const bow = (width: number) => [
        {
            points: [
                [0, 0],
                [width, 1],
                [0, 1],
                [width, 0],
            ] as [number, number][],
        },
    ]
    assert.equal(area(kernel.triangulate(bow(800000), 'nonzero', 1)!), 400000)
    assert.equal(kernel.triangulate(bow(900000), 'nonzero', 1), undefined)
    // All input vertices are exact integers, while the crossing is (1.2, 0.8).
    // Its new fractional coordinates must survive restoration, independently
    // of the input conversion check.
    const distantCross = (origin: number) => [
        {
            points: [
                [origin, 0],
                [origin + 3, 2],
                [origin, 2],
                [origin + 2, 0],
            ] as [number, number][],
        },
    ]
    assert.ok(
        Math.abs(area(kernel.triangulate(distantCross(2 ** 40), 'nonzero', 64)!) - 2.6) < 0.001,
    )
    assert.equal(kernel.triangulate(distantCross(2 ** 44), 'nonzero', 64), undefined)
    assert.equal(area(kernel.triangulate(square, 'nonzero', 64)!), 16)
    kernel.dispose()
})

test('owned output survives reuse, detached native views and terminal disposal', () => {
    const native = instance()
    const kernel = new LyonTessellator(native)
    const output = kernel.triangulate(square, 'nonzero', 64)!
    const saved = output.slice()
    const memory = native.memory as WebAssembly.Memory
    const old = new Uint8Array(memory.buffer)
    memory.grow(8)
    assert.equal(old.byteLength, 0)
    assert.equal(area(kernel.triangulate(square, 'evenodd', 64)!), 16)
    assert.deepEqual(output, saved)
    kernel.dispose()
    kernel.dispose()
    assert.equal(kernel.triangulate(square, 'nonzero', 64), undefined)
    assert.deepEqual(output, saved)
})

for (const failure of ['allocation', 'status', 'trap', 'output'] as const)
    test(`Lyon ${failure} failure retires without publishing stale triangles`, () => {
        const native = instance()
        let failing = false,
            attempts = 0,
            destructors = 0
        const kernel = new LyonTessellator({
            ...native,
            reserve: (...args: number[]) =>
                failing && failure === 'allocation'
                    ? 0
                    : (native.reserve as CallableFunction)(...args),
            run: (...args: number[]) => {
                attempts++
                if (failing && failure === 'trap')
                    throw new WebAssembly.RuntimeError('injected panic')
                if (failing && failure === 'status') return -3
                return (native.run as CallableFunction)(...args)
            },
            output_length: () =>
                failing && failure === 'output' ? 5 : (native.output_length as CallableFunction)(),
            dispose: () => {
                destructors++
                return (native.dispose as CallableFunction)()
            },
        })
        const saved = kernel.triangulate(square, 'nonzero', 64)!.slice()
        failing = true
        assert.equal(kernel.triangulate(square, 'nonzero', 64), undefined)
        const count = attempts
        assert.equal(kernel.triangulate(square, 'nonzero', 64), undefined)
        assert.equal(attempts, count)
        kernel.dispose()
        assert.equal(destructors, 0, 'do not call a possibly corrupted native instance again')
        assert.equal(area(saved), 16)
    })

test('asset HTTP, CSP/compile and hung-request failures resolve to JS availability', async () => {
    const originalFetch = globalThis.fetch
    try {
        globalThis.fetch = async () => new Response('', { status: 404 })
        assert.equal(await loadLyon(new URL('https://test.invalid/lyon.wasm'), 20), undefined)
        globalThis.fetch = async () => new Response('invalid wasm')
        assert.equal(await loadLyon(new URL('https://test.invalid/lyon.wasm'), 20), undefined)
        let signal: AbortSignal | null | undefined
        globalThis.fetch = async (_url, init) => {
            signal = init?.signal
            return new Promise<Response>(() => {})
        }
        assert.equal(await loadLyon(new URL('https://test.invalid/lyon.wasm'), 20), undefined)
        assert.equal(signal?.aborted, true)
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('unsupported geometry follows the exact original JS path after initialization', async () => {
    const thin = [
        {
            points: [
                [0, 0],
                [1000000, 0],
                [1000000, 0.001],
                [0, 0.001],
            ] as [number, number][],
        },
    ]
    const expected = triangulate(thin, 'nonzero', 64)
    assert.equal(area(expected), 1000)
    const originalFetch = globalThis.fetch
    try {
        globalThis.fetch = async () => new Response(bytes)
        await initializeLyon()
    } finally {
        globalThis.fetch = originalFetch
    }
    assert.deepEqual(triangulate(thin, 'nonzero', 64), expected)
    assert.equal(area(triangulate(square, 'nonzero', 64)), 16)
})

test('unknown resolution preserves JS while an explicit resolution reaches the active kernel', async (t) => {
    const fractional = [
        {
            points: [
                [0.1, 0.2],
                [4.3, 0.2],
                [0.1, 4.4],
            ] as [number, number][],
        },
    ]
    const expected = triangulate(fractional, 'nonzero')
    const originalFetch = globalThis.fetch
    try {
        globalThis.fetch = async () => new Response(bytes)
        await initializeLyon()
    } finally {
        globalThis.fetch = originalFetch
    }
    const native = LyonTessellator.prototype.triangulate
    let attempts = 0
    t.mock.method(
        LyonTessellator.prototype,
        'triangulate',
        function (this: LyonTessellator, ...args: Parameters<LyonTessellator['triangulate']>) {
            attempts++
            const result = native.apply(this, args)
            assert.ok(result, 'the supported explicit-resolution witness must use Lyon')
            return result
        },
    )
    assert.deepEqual(triangulate(fractional, 'nonzero'), expected)
    assert.equal(attempts, 0)
    assert.equal(area(triangulate(square, 'nonzero', 64)), 16)
    assert.equal(attempts, 1)
})

test('a module finishing after the startup deadline is disposed rather than installed', async () => {
    const originalFetch = globalThis.fetch
    const originalInstantiate = WebAssembly.instantiate
    const native = instance()
    let completeFetch: (response: Response) => void = () => {
        throw new Error('fetch not started')
    }
    let disposed = 0
    try {
        globalThis.fetch = async () =>
            new Promise<Response>((resolve) => {
                completeFetch = resolve
            })
        Object.defineProperty(WebAssembly, 'instantiate', {
            configurable: true,
            writable: true,
            value: async () => ({
                instance: {
                    exports: {
                        ...native,
                        dispose: () => {
                            disposed++
                            return (native.dispose as CallableFunction)()
                        },
                    },
                },
            }),
        })
        assert.equal(await loadLyon(new URL('https://test.invalid/late.wasm'), 5), undefined)
        completeFetch(new Response(bytes))
        await new Promise((resolve) => setTimeout(resolve, 10))
        assert.equal(disposed, 1)
    } finally {
        globalThis.fetch = originalFetch
        Object.defineProperty(WebAssembly, 'instantiate', {
            configurable: true,
            writable: true,
            value: originalInstantiate,
        })
    }
})
