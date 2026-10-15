import assert from 'node:assert/strict'
import test from 'node:test'
import { strokeOffscreenAnchorBody } from '../../src/editor/canvas/noteOutline'
import type { WebGLDrawContext } from '../../src/rendering/context'
import { DrawGradient } from '../../src/rendering/paint'

type Transform = { a: number; b: number; c: number; d: number; e: number; f: number }
type State = {
    transform: Transform
    lineWidth: number
    strokeStyle: string | DrawGradient
    globalAlpha: number
    globalCompositeOperation: GlobalCompositeOperation
}
type Line = State & { points: [number, number, number, number] }

const identity = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
const recording = (
    options: Partial<Omit<State, 'transform'>> & {
        transform?: Partial<Transform>
        throwAt?: number
    } = {},
) => {
    let transform = { a: 20, b: 0, c: 0, d: 20, e: -10, f: 20, ...options.transform }
    let attempts = 0
    const stack: State[] = []
    const lines: Line[] = []
    const events: string[] = []
    const ctx = {
        canvas: { width: 200, height: 120 },
        lineWidth: options.lineWidth ?? 0.2,
        strokeStyle: options.strokeStyle ?? '#fff',
        globalAlpha: options.globalAlpha ?? 0.35,
        globalCompositeOperation: options.globalCompositeOperation ?? 'source-over',
        getTransform: () => ({ ...transform }),
        save: () => {
            events.push('save')
            stack.push(snapshot())
        },
        resetTransform: () => {
            events.push('resetTransform')
            transform = { ...identity }
        },
        restore: () => {
            events.push('restore')
            const state = stack.pop()
            assert.ok(state, 'restore must balance an earlier save')
            transform = state.transform
            ctx.lineWidth = state.lineWidth
            ctx.strokeStyle = state.strokeStyle
            ctx.globalAlpha = state.globalAlpha
            ctx.globalCompositeOperation = state.globalCompositeOperation
        },
        strokeLine: (x: number, y: number, x1: number, y1: number) => {
            events.push('strokeLine')
            if (++attempts === options.throwAt) throw new Error('draw failed')
            lines.push({ ...snapshot(), points: [x, y, x1, y1] })
        },
    }
    const snapshot = (): State => ({
        transform: ctx.getTransform(),
        lineWidth: ctx.lineWidth,
        strokeStyle: ctx.strokeStyle,
        globalAlpha: ctx.globalAlpha,
        globalCompositeOperation: ctx.globalCompositeOperation,
    })
    return {
        ctx,
        lines,
        events,
        snapshot,
        get savedStates() {
            return stack.length
        },
        draw: (x = 0, width = 30) =>
            strokeOffscreenAnchorBody(ctx as unknown as WebGLDrawContext, x, width),
    }
}

const assertFallback = (r: ReturnType<typeof recording>, x = 0, width = 30) => {
    const before = r.snapshot()
    assert.equal(r.draw(x, width), false)
    assert.deepEqual(r.lines, [], 'fallback must leave the original rounded path to its caller')
    assert.deepEqual(r.events, [])
    assert.deepEqual(r.snapshot(), before)
    assert.equal(r.savedStates, 0)
}

test('offscreen rounded ends become two flat device-space edges without changing paint state', () => {
    // Two CSS pixels at DPR 2: scene width .2 transformed by 20 yields 4 device pixels.
    const r = recording({ strokeStyle: '#4080c080', globalAlpha: 0.375 })
    const before = r.snapshot()
    assert.equal(r.draw(), true)
    assert.deepEqual(
        r.lines.map(({ points, lineWidth }) => ({ points, lineWidth })),
        [
            { points: [-2, 23, 202, 23], lineWidth: 4 },
            { points: [-2, 29, 202, 29], lineWidth: 4 },
        ],
    )
    for (const line of r.lines) {
        assert.deepEqual(line.transform, identity)
        assert.equal(line.strokeStyle, '#4080c080')
        assert.equal(line.globalAlpha, 0.375)
        assert.equal(line.globalCompositeOperation, 'source-over')
    }
    assert.deepEqual(r.snapshot(), before)
    assert.equal(r.savedStates, 0)
    assert.deepEqual(r.events, ['save', 'resetTransform', 'strokeLine', 'strokeLine', 'restore'])
})

test('both rounded ends must pass the full-canvas antialias margin strictly', () => {
    // At e=-6 the left flat edge is exactly -2; at e=-394 the right is exactly 202.
    for (const e of [-6, -5.999, -394, -394.001]) assertFallback(recording({ transform: { e } }))
    for (const e of [-6.001, -393.999]) {
        const r = recording({ transform: { e } })
        assert.equal(r.draw(), true)
        assert.equal(r.lines.length, 2)
    }
    assertFallback(recording(), 0, 10)
    assertFallback(recording({ transform: { e: 300 } }))
    assertFallback(recording({ transform: { e: -700 } }))
})

test('corner visibility includes the stroke reach, not only the rounded-rectangle centerline', () => {
    // The radius alone reaches -3, but the stroke's inner flat boundary reaches -1.
    assertFallback(recording({ transform: { e: -5 } }))
    assertFallback(recording({ transform: { a: -20, e: 205 } }))
})

test('reflections on either axis preserve the viewport coverage and restore the transform', () => {
    for (const a of [20, -20])
        for (const d of [20, -20]) {
            const r = recording({ transform: { a, d, e: a > 0 ? -10 : 210, f: d > 0 ? 20 : 80 } })
            const before = r.snapshot()
            assert.equal(r.draw(), true)
            assert.deepEqual(
                r.lines.map((line) => line.points),
                d > 0
                    ? [
                          [-2, 23, 202, 23],
                          [-2, 29, 202, 29],
                      ]
                    : [
                          [-2, 77, 202, 77],
                          [-2, 71, 202, 71],
                      ],
            )
            assert.ok(r.lines.every((line) => line.lineWidth === 4))
            assert.deepEqual(r.snapshot(), before)
        }
})

test('rotation, shear and collapsed axes leave the rounded path unchanged', () => {
    for (const transform of [
        { a: 0, b: 20, c: -20, d: 0 },
        { b: 0.1 },
        { c: -0.1 },
        { b: 1e-12 },
        { a: 0 },
        { d: 0 },
    ])
        assertFallback(recording({ transform }))
})

test('top and bottom stay a compound outline when their antialias coverage could overlap', () => {
    for (const d of [20, -20])
        for (const lineWidth of [0.25, 0.250001, 0.3, 0.4]) {
            assertFallback(recording({ transform: { d }, lineWidth }))
        }
    const justSeparated = recording({ lineWidth: 0.249999 })
    assert.equal(justSeparated.draw(), true)
    const [top, bottom] = justSeparated.lines
    assert.ok(top && bottom)
    assert.ok(bottom.points[1] - bottom.lineWidth / 2 - (top.points[1] + top.lineWidth / 2) >= 1)
})

test('subpixel stroke widths fall back while one full device pixel is eligible', () => {
    assertFallback(recording({ lineWidth: 0.049999 }))
    assertFallback(recording({ lineWidth: 0 }))
    const r = recording({ lineWidth: 0.05 })
    assert.equal(r.draw(), true)
    assert.ok(r.lines.every((line) => line.lineWidth === 1))
})

test('gradient and non-source-over paints keep the original operation', () => {
    const gradient = new DrawGradient([0, 0], [0, 1])
    gradient.addColorStop(0, '#fff')
    gradient.addColorStop(1, '#fff0')
    assertFallback(recording({ strokeStyle: gradient }))
    for (const globalCompositeOperation of ['destination-out', 'multiply', 'copy'] as const) {
        assertFallback(recording({ globalCompositeOperation }))
    }
})

test('invalid coordinates or dimensions never enqueue flat edges', () => {
    for (const x of [NaN, Infinity, -Infinity]) assertFallback(recording(), x)
    for (const width of [0, -1, NaN, Infinity]) assertFallback(recording(), 0, width)
    for (const transform of [{ a: Infinity }, { d: NaN }, { e: Infinity }, { f: NaN }]) {
        assertFallback(recording({ transform }))
    }
    assertFallback(recording({ lineWidth: NaN }))
})

test('finite inputs that overflow transformed bounds or stroke width draw nothing', () => {
    // Both flat boundaries overflow in opposite directions, so a viewport-only
    // comparison would otherwise mistake this for an eligible oversized note.
    assertFallback(recording({ transform: { a: Number.MAX_VALUE, e: 0 } }), -2, 4)
    assertFallback(recording({ transform: { d: Number.MAX_VALUE }, lineWidth: 2 }), -1)
})

test('overflow while quantizing finite edge centers cannot partially draw an outline', () => {
    for (const f of [Number.MAX_VALUE, -Number.MAX_VALUE]) {
        // The translation is finite; multiplying its edge coordinate by four is not.
        assertFallback(recording({ transform: { f } }))
    }
})

test('fractional edges resolve on quarter pixels separately for each repeated note', () => {
    const r = recording({ transform: { f: 20.03 }, lineWidth: 0.11, globalAlpha: 0.5 })
    const before = r.snapshot()
    assert.equal(r.draw(), true)
    assert.equal(r.draw(), true)
    assert.deepEqual(
        r.lines.map(({ points, lineWidth, globalAlpha }) => ({ points, lineWidth, globalAlpha })),
        [
            { points: [-2, 23.125, 202, 23.125], lineWidth: 2.25, globalAlpha: 0.5 },
            { points: [-2, 29.125, 202, 29.125], lineWidth: 2.25, globalAlpha: 0.5 },
            { points: [-2, 23.125, 202, 23.125], lineWidth: 2.25, globalAlpha: 0.5 },
            { points: [-2, 29.125, 202, 29.125], lineWidth: 2.25, globalAlpha: 0.5 },
        ],
    )
    assert.deepEqual(r.snapshot(), before)
    assert.equal(r.savedStates, 0)
})

test('the original opacity is applied once to each disjoint edge', () => {
    for (const globalAlpha of [0, 0.125, 0.75, 1]) {
        const r = recording({ globalAlpha })
        assert.equal(r.draw(), true)
        assert.deepEqual(
            r.lines.map((line) => line.globalAlpha),
            [globalAlpha, globalAlpha],
        )
        assert.equal(r.ctx.globalAlpha, globalAlpha)
    }
})

test('a failure in either stroke restores the caller transform and paint state', () => {
    for (const throwAt of [1, 2]) {
        const r = recording({ throwAt, globalAlpha: 0.625, strokeStyle: '#fff8' })
        const before = r.snapshot()
        assert.throws(() => r.draw(), /draw failed/)
        assert.deepEqual(r.snapshot(), before)
        assert.equal(r.savedStates, 0)
        assert.equal(r.events.at(-1), 'restore')
        assert.equal(r.lines.length, throwAt - 1)
    }
})
