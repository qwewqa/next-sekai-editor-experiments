import assert from 'node:assert/strict'
import test from 'node:test'
import type { StageId } from '../../src/chart/stages'
import { createStageSurface } from '../../src/editor/canvas/stageSurface'
import type { EditorDrawContext } from '../../src/editor/canvas/types'
import { createScopeLookup, fullScope, type ScopeLookup } from '../../src/editor/scopeRules'

const stageProps = (left = -2, right = 2, pivot = 0) => ({
    left,
    right,
    pivotLane: pivot,
    xLaneTranslate: 0,
    laneAlpha: 1,
    laneColor: { start: 0, end: 0, progress: 0 },
    fullWidth: 0,
    divisionLineAlpha: 1,
    division: { start: { size: 2, parity: 0 }, end: { size: 2, parity: 0 }, progress: 0 },
    leftBorderStyle: { start: 1, end: 1, progress: 0 },
    rightBorderStyle: { start: 1, end: 1, progress: 0 },
})

type Mesh = { id: number; vertices: number[]; matrix: number[]; released: boolean }

// A renderer double: retained meshes record their packed scene, draws record their offsets.
const fakeRenderer = () => {
    const meshes: Mesh[] = []
    const draws: { mesh: Mesh; x: number; y: number }[] = []
    const ops: string[] = []
    const ctx = {
        lineCap: 'butt',
        globalCompositeOperation: 'source-over',
        globalAlpha: 1,
        lineWidth: 1,
        strokeStyle: '#000',
        fillStyle: '#000',
        resourceOwner: {},
        lost: false,
        getLineDash: () => [] as number[],
        getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
        isContextLost() {
            return this.lost
        },
        createStageMesh(vertices: readonly number[], matrix: number[]) {
            const mesh = { id: meshes.length, vertices: [...vertices], matrix, released: false }
            meshes.push(mesh)
            return mesh
        },
        drawStageMesh(mesh: Mesh, x: number, y: number) {
            assert.equal(mesh.released, false, 'a released mesh is never drawn')
            draws.push({ mesh, x, y })
            ops.push(`mesh:${mesh.id}`)
        },
        releaseStageMesh(mesh: Mesh) {
            assert.equal(mesh.released, false, 'each mesh is released once')
            mesh.released = true
        },
        drawStageTriangles() {
            ops.push('direct')
        },
        save() {},
        restore() {},
        beginPath() {},
        moveTo() {},
        lineTo() {},
        closePath() {},
        clip() {},
        stroke() {},
        fill() {
            ops.push('fill')
        },
    }
    return { ctx, meshes, draws, ops }
}

const setup = (stage: (id: number, beat: number) => ReturnType<typeof stageProps> | undefined) => {
    const renderer = fakeRenderer()
    const stages = new Map([
        [1 as StageId, { startBeat: 0, endBeat: 1000, breakpoints: [] }],
        [2 as StageId, { startBeat: 0, endBeat: 1000, breakpoints: [] }],
    ])
    const context = {
        ctx: renderer.ctx,
        pixelRatio: 1,
        scale: 25,
        ups: -1,
        // 400 by 200 CSS pixels: 16 lanes by 8 seconds.
        bounds: { l: -8, r: 8, t: -18, b: -10, w: 16, h: 8 },
        state: { bpms: [{ x: 0, y: 0, s: 1, meter: 4, measure: 0, measureBeat: 0 }] },
        composed: { stages, stage, gridOffset: () => 0 },
    } as unknown as EditorDrawContext
    const surface = createStageSurface()
    let scope: ScopeLookup = fullScope
    let laneDivision = 1
    const draw = (change: Partial<EditorDrawContext> = {}) => {
        Object.assign(context, change)
        renderer.draws.length = 0
        renderer.ops.length = 0
        // One second per beat.
        const { bounds, ups } = context
        const beats = { min: Math.max(0, bounds.b / ups), max: bounds.t / ups }
        surface.draw(context, 400, 200, beats, scope, laneDivision)
    }
    return {
        ...renderer,
        context,
        surface,
        draw,
        scroll(seconds: number) {
            const { bounds } = context
            draw({ bounds: { ...bounds, t: bounds.t - seconds, b: bounds.b - seconds } })
        },
        setScope(next: ScopeLookup) {
            scope = next
        },
        setLaneDivision(next: number) {
            laneDivision = next
        },
    }
}

test('tiles are built once in view and only offset while the view scrolls', () => {
    const chart = setup(() => stageProps())
    chart.draw()
    // 200 CSS pixels of 128-pixel tiles: two or three tiles, each one mesh.
    const built = chart.meshes.length
    assert.ok(built >= 2 && built <= 3, `built ${built}`)
    assert.deepEqual(
        chart.draws.map(({ mesh }) => mesh.id),
        chart.meshes.map(({ id }) => id),
    )
    const before = chart.draws.map(({ mesh, y }) => [mesh.id, y])
    // A small scroll redraws the same meshes 2.5 device pixels lower, building none.
    chart.scroll(0.1)
    assert.equal(chart.meshes.length, built + 1, 'one tile ahead is prepared while moving')
    const ahead = chart.meshes.at(-1)!
    assert.ok(chart.draws.every(({ mesh }) => mesh !== ahead))
    for (const [id, y] of before) {
        const draw = chart.draws.find(({ mesh }) => mesh.id === id)!
        assert.ok(Math.abs(draw.y - ((y as number) + 2.5)) < 1e-9)
        assert.equal(draw.x, 8 * 25)
    }
    // The prepared tile is drawn without building when it comes into view.
    chart.scroll(4)
    assert.ok(chart.draws.some(({ mesh }) => mesh === ahead))
    // A still redraw builds nothing.
    const count = chart.meshes.length
    chart.draw()
    chart.draw()
    assert.equal(chart.meshes.length, count)
    assert.ok(chart.meshes.every(({ released }) => !released))
})

test('tiles draw in chart time order and an unsupported slice keeps its place', () => {
    // Stage 2 is too wide to pack: its slices fall back to the ordinary renderer.
    const chart = setup((id) => (id === 1 ? stageProps(-6, -4) : stageProps(-2, 200000)))
    chart.draw()
    // Earlier chart time is lower on screen: each tile draws its stage 1 mesh, then stage 2's fill.
    assert.ok(chart.ops.length >= 4)
    for (let i = 0; i < chart.ops.length; i += 2) {
        assert.match(chart.ops[i]!, /^mesh:/)
        assert.equal(chart.ops[i + 1], 'fill')
    }
    const ys = chart.draws.map(({ y }) => y)
    assert.deepEqual(
        ys,
        [...ys].sort((a, b) => b - a),
    )
})

test('edits, zoom, pixel ratio, scope, lane division and the renderer release every tile', () => {
    const chart = setup(() => stageProps())
    const { context } = chart
    const changes: [string, () => void][] = [
        [
            'stage event',
            () =>
                chart.draw({
                    composed: { ...context.composed!, stages: new Map(context.composed!.stages) },
                }),
        ],
        ['tempo', () => chart.draw({ state: { ...context.state, bpms: [...context.state.bpms] } })],
        ['zoom', () => chart.draw({ scale: 30, bounds: { ...context.bounds, r: 5.33, w: 13.33 } })],
        ['time zoom', () => chart.draw({ ups: -2 })],
        ['pixel ratio', () => chart.draw({ pixelRatio: 1.5 })],
        [
            'scope',
            () => {
                chart.setScope(createScopeLookup({ stageId: 2 as StageId }))
                chart.draw()
            },
        ],
        [
            'lane division',
            () => {
                chart.setLaneDivision(4)
                chart.draw()
            },
        ],
        [
            'renderer',
            () => chart.draw({ ctx: { ...context.ctx, resourceOwner: {} } as typeof context.ctx }),
        ],
        [
            'context loss',
            () => {
                ;(context.ctx as unknown as { lost: boolean }).lost = true
                chart.draw()
                ;(context.ctx as unknown as { lost: boolean }).lost = false
            },
        ],
    ]
    chart.draw()
    for (const [name, change] of changes) {
        const old = [...chart.meshes]
        change()
        chart.draw()
        assert.ok(
            old.every(({ released }) => released),
            `${name} releases the old tiles`,
        )
        assert.ok(chart.meshes.length > old.length, `${name} builds new tiles`)
        assert.ok(chart.draws.length > 0)
        assert.ok(
            chart.draws.every(({ mesh }) => !old.includes(mesh)),
            `${name} draws new tiles`,
        )
    }
})

test('a pan within the tiles’ lane margin reuses them; a farther pan builds them again', () => {
    const chart = setup(() => stageProps())
    const { context } = chart
    chart.draw()
    const built = chart.meshes.length
    const pan = (lanes: number) =>
        chart.draw({
            bounds: { ...context.bounds, l: context.bounds.l + lanes, r: context.bounds.r + lanes },
        })
    // A quarter view: four lanes either side.
    pan(3.5)
    assert.equal(chart.meshes.length, built)
    assert.equal(chart.draws[0]?.x, (8 - 3.5) * 25)
    pan(1)
    assert.ok(chart.meshes.slice(0, built).every(({ released }) => released))
    assert.ok(chart.meshes.length > built)
})

test('limits release the oldest tiles out of view, never visible ones', () => {
    const chart = setup((_, beat) => stageProps(-2, 2, beat))
    chart.draw()
    // Far jumps leave many tiles behind; at most 96 stay retained.
    for (let i = 0; i < 80; i++) chart.scroll(8)
    const live = chart.meshes.filter(({ released }) => !released)
    assert.ok(chart.surface.stats.tiles <= 96)
    assert.ok(chart.surface.stats.tiles > 2)
    assert.ok(chart.draws.every(({ mesh }) => !mesh.released))
    // The first tiles were the oldest.
    assert.ok(chart.meshes[0]!.released)
    assert.equal(
        live.reduce((sum, mesh) => sum + mesh.vertices.length, 0),
        chart.surface.stats.floats,
    )
})

test('Basic and unsupported drawing state release tiles; clear releases each mesh once', () => {
    const chart = setup(() => stageProps())
    chart.draw()
    const first = [...chart.meshes]
    chart.draw({ composed: undefined })
    assert.ok(first.every(({ released }) => released))
    assert.equal(chart.surface.stats.tiles, 0)
    chart.draw({ composed: setup(() => stageProps()).context.composed })
    const second = [...chart.meshes]
    ;(chart.context.ctx as unknown as { lineCap: string }).lineCap = 'round'
    chart.draw()
    assert.ok(second.every(({ released }) => released))
    assert.ok(chart.ops.includes('fill'), 'an unusual stroke state draws directly')
    ;(chart.context.ctx as unknown as { lineCap: string }).lineCap = 'butt'
    chart.draw()
    chart.surface.clear()
    chart.surface.clear()
    assert.ok(chart.meshes.every(({ released }) => released))
})
