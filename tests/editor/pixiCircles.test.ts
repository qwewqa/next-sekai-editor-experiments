import assert from 'node:assert/strict'
import test from 'node:test'
import { buildContextBatches, GraphicsContext, type StrokeStyle } from 'pixi.js'
import { WebGLDrawContext } from '../../src/rendering/context'
import type { Matrix } from '../../src/rendering/matrix'
import { DrawGradient, type DrawStyle } from '../../src/rendering/paint'
import { DrawPath } from '../../src/rendering/path'
import { PathGraphicsCache } from '../../src/rendering/pathGraphics'

type Call = {
    path: DrawPath
    style: StrokeStyle
    stroke: boolean
    rule: CanvasFillRule
    dash: readonly number[]
    dashOffset: number
    resolution: number
    matrix?: Matrix
}

function harness() {
    const state = {
        matrix: [1, 0, 0, 1, 0, 0] as Matrix,
        fillStyle: '#ff0000' as DrawStyle,
        strokeStyle: '#0000ff' as DrawStyle,
        globalAlpha: 0.35,
        globalCompositeOperation: 'source-over' as GlobalCompositeOperation,
        lineWidth: 0.04,
        lineCap: 'round' as CanvasLineCap,
        lineJoin: 'bevel' as CanvasLineJoin,
        miterLimit: 7,
        lineDashOffset: 0.05,
        dash: [0.1, 0.2],
    }
    const calls: Call[] = []
    const nodes: { blendMode: string; alpha: number }[] = []
    const paintInputs: DrawStyle[] = []
    let mutable = true
    const internal = Object.assign(Object.create(WebGLDrawContext.prototype) as object, {
        state,
        primitivePaths: new Map<string, DrawPath>(),
        mutate: () => mutable,
        paints: {
            fill(style: DrawStyle) {
                paintInputs.push(style)
                return { style: { color: 0xff0000 }, key: 'fill' }
            },
            stroke(
                style: DrawStyle,
                width: number,
                cap: CanvasLineCap,
                join: CanvasLineJoin,
                miterLimit: number,
            ) {
                paintInputs.push(style)
                return { style: { color: 0x0000ff, width, cap, join, miterLimit }, key: 'stroke' }
            },
        },
        paths: {
            // This submission harness uses positive-radius circles; actual
            // emptiness classification is exercised with real caches separately.
            isEmpty: () => false,
            get(...args: Parameters<PathGraphicsCache['get']>) {
                const [path, style, stroke, rule, , extras, resolution = 1] = args
                calls.push({
                    path,
                    style: style as StrokeStyle,
                    stroke,
                    rule,
                    dash: [...(extras?.dash ?? [])],
                    dashOffset: extras?.dashOffset ?? 0,
                    resolution,
                })
                return {} as GraphicsContext
            },
        },
        graphic(_context: GraphicsContext, matrix: Matrix) {
            calls.at(-1)!.matrix = [...matrix]
            return { blendMode: 'normal', alpha: state.globalAlpha }
        },
        parent: () => ({
            addChild: (node: { blendMode: string; alpha: number }) => nodes.push(node),
        }),
    })
    return {
        context: internal as unknown as WebGLDrawContext,
        state,
        calls,
        nodes,
        paintInputs,
        internal,
        setMutable: (value: boolean) => {
            mutable = value
        },
    }
}

function close(actual: number, expected: number) {
    assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`)
}

function effectiveMatrix(call: Call): Matrix {
    const [a, b, c, d, e, f] = call.matrix!
    return [
        a * call.resolution,
        b * call.resolution,
        c * call.resolution,
        d * call.resolution,
        e,
        f,
    ]
}

test('solid circles share retained geometry across positions while their transforms preserve placement', () => {
    const { context, state, calls } = harness()
    const matrix = state.matrix
    context.fillCircle(12, 34, 8)
    context.fillCircle(-6, 7, 32)
    assert.equal(calls[0]?.path, calls[1]?.path)
    assert.deepEqual(effectiveMatrix(calls[0]!), [0.5, 0, 0, 0.5, 12, 34])
    assert.deepEqual(effectiveMatrix(calls[1]!), [2, 0, 0, 2, -6, 7])
    assert.equal(state.matrix, matrix)
    assert.deepEqual(calls[0]?.dash, [])
    assert.equal(calls[0]?.dashOffset, 0)
})

test('circle normalization composes with skewed transforms and preserves alpha and erase blending', () => {
    const { context, state, calls, nodes } = harness()
    state.matrix = [2, 0.5, -0.25, 3, 11, -8]
    state.globalCompositeOperation = 'destination-out'
    const before = structuredClone(state)
    context.fillCircle(12, 34, 8)
    assert.deepEqual(effectiveMatrix(calls[0]!), [1, 0.25, -0.125, 1.5, 26.5, 100])
    assert.deepEqual(nodes, [{ blendMode: 'erase', alpha: 0.35 }])
    assert.deepEqual(state, before)
})

test('circle strokes keep their world-space width and dash phase under normalization', () => {
    const { context, state, calls } = harness()
    const before = structuredClone(state)
    const originalDash = state.dash
    context.strokeCircle(12, 34, 0.1)
    const call = calls[0]!
    const scale = effectiveMatrix(call)[0]
    close(call.style.width! * scale, before.lineWidth)
    close(call.dash[0]! * scale, before.dash[0]!)
    close(call.dash[1]! * scale, before.dash[1]!)
    close(call.dashOffset * scale, before.lineDashOffset)
    assert.equal(call.style.cap, before.lineCap)
    assert.equal(call.style.join, before.lineJoin)
    assert.equal(call.style.miterLimit, before.miterLimit)
    assert.equal(call.stroke, true)
    assert.equal(state.dash, originalDash)
    assert.deepEqual(state, before)
})

test('gradient circles retain user-space geometry and paint coordinates for fill and stroke', () => {
    const { context, state, calls, paintInputs } = harness()
    const gradient = new DrawGradient([10, 20], [30, 40])
    state.fillStyle = gradient
    state.strokeStyle = gradient
    state.matrix = [2, 0.5, -0.25, 3, 11, -8]
    context.fillCircle(12, 34, 0.1)
    context.strokeCircle(12, 34, 0.1)
    assert.equal(calls[0]?.path, calls[1]?.path)
    for (const call of calls) {
        assert.deepEqual(call.path.commands, [
            ['ellipse', 12, 34, 0.1, 0.1, 0, 0, Math.PI * 2, false],
        ])
        assert.deepEqual(effectiveMatrix(call), state.matrix)
    }
    assert.equal(calls[1]?.style.width, state.lineWidth)
    assert.deepEqual(calls[1]?.dash, state.dash)
    assert.equal(calls[1]?.dashOffset, state.lineDashOffset)
    assert.deepEqual(paintInputs, [gradient, gradient])
    assert.deepEqual(gradient.start, [10, 20])
    assert.deepEqual(gradient.end, [30, 40])
})

test('circle validation preserves empty/nonfinite behavior and rejects negative radii', () => {
    const { context, calls, internal, setMutable } = harness()
    for (const draw of [context.fillCircle.bind(context), context.strokeCircle.bind(context)]) {
        draw(NaN, 0, 1)
        draw(0, Infinity, 1)
        draw(0, 0, Infinity)
        draw(0, 0, 0)
        assert.throws(() => draw(0, 0, -1), { name: 'IndexSizeError' })
    }
    setMutable(false)
    context.fillCircle(1, 2, 3)
    assert.equal(calls.length, 0)
    assert.equal(internal.primitivePaths.size, 0)
})

test('internal circle normalization cannot leak state when geometry submission throws', () => {
    const { context, state, internal } = harness()
    const before = structuredClone(state)
    internal.paths.get = () => {
        throw new Error('submission failed')
    }
    assert.throws(() => context.strokeCircle(12, 34, 0.1), /submission failed/)
    assert.deepEqual(state, before)
})

test('event-marker circle tessellation stays within 0.03 device pixels at DPR 1, 2 and 3', () => {
    const cache = new PathGraphicsCache()
    try {
        for (const dpr of [1, 2, 3]) {
            const { context, state, calls } = harness()
            // 40 pixels per editor lane; the application marker radius is 0.1 lane.
            state.matrix = [40 * dpr, 0, 0, 40 * dpr, 0, 0]
            context.fillCircle(2, 3, 0.1)
            const call = calls[0]!
            const graphics = cache.get(
                call.path,
                call.style,
                false,
                'nonzero',
                'marker',
                undefined,
                call.resolution,
            )
            assert.ok(
                graphics instanceof GraphicsContext,
                'marker circles keep native ellipse geometry',
            )
            const geometryData = {
                vertices: [] as number[],
                indices: [] as number[],
                uvs: [] as number[],
            }
            buildContextBatches(graphics, { geometryData, batches: [] } as unknown as Parameters<
                typeof buildContextBatches
            >[1])
            const m = call.matrix!
            const center = [80 * dpr, 120 * dpr]
            const radius = 4 * dpr
            const perimeter: [number, number][] = []
            for (let i = 0; i < geometryData.vertices.length; i += 2) {
                const x = geometryData.vertices[i]!,
                    y = geometryData.vertices[i + 1]!
                const p: [number, number] = [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
                if (Math.hypot(p[0] - center[0]!, p[1] - center[1]!) < radius / 2) continue
                close(Math.hypot(p[0] - center[0]!, p[1] - center[1]!), radius)
                perimeter.push(p)
            }
            assert.ok(perimeter.length >= 12)
            for (let i = 0; i < perimeter.length; i++) {
                const a = perimeter[i]!,
                    b = perimeter[(i + 1) % perimeter.length]!
                const distance = Math.hypot(
                    (a[0] + b[0]) / 2 - center[0]!,
                    (a[1] + b[1]) / 2 - center[1]!,
                )
                assert.ok(radius - distance <= 0.03, `DPR ${dpr} edge error ${radius - distance}`)
            }
        }
    } finally {
        cache.destroy()
    }
})
