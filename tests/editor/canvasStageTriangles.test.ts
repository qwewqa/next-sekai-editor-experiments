import assert from 'node:assert/strict'
import test from 'node:test'
import { Container, GlProgram, Shader } from 'pixi.js'
import { drawComposedStages } from '../../src/editor/canvas/stages'
import type { EditorDrawContext } from '../../src/editor/canvas/types'
import { fullScope } from '../../src/editor/scopeRules'
import { WebGLDrawContext } from '../../src/rendering/context'
import { StageMeshes, StageTriangles } from '../../src/rendering/stageMesh'

const triangle = () => new Float64Array([0, 0, 2, 0, 0, 3])

function meshesWithoutGpu() {
    const meshes = new StageMeshes()
    // The tests exercise Pixi geometry/ownership, not program compilation. A
    // program stub avoids creating Pixi's browser probe context.
    const glProgram = Object.create(GlProgram.prototype) as GlProgram
    const shader = new Shader({ glProgram, resources: {} })
    Object.assign(meshes, { shader })
    return { meshes, shader }
}

test('stage triangle stream preserves paint order and premultiplies opacity once', () => {
    const stream = new StageTriangles()
    const source = triangle()
    stream.append(source, 0xff8040, 0.16)
    stream.append(source, 0x4080ff, 0.4)
    stream.append(source, 0xffffff, 0)
    assert.equal(stream.vertices.length, 36)
    assert.deepEqual(source, triangle())
    assert.deepEqual(stream.vertices.slice(0, 6), [
        0,
        0,
        0.16,
        (128 / 255) * 0.16,
        (64 / 255) * 0.16,
        0.16,
    ])
    assert.deepEqual(stream.vertices.slice(18, 24), [
        0,
        0,
        (64 / 255) * 0.4,
        (128 / 255) * 0.4,
        0.4,
        0.4,
    ])
    for (let vertex = 0; vertex < 6; vertex++) {
        assert.deepEqual(
            stream.vertices.slice(vertex * 6, vertex * 6 + 2),
            Array.from(source.slice((vertex % 3) * 2, (vertex % 3) * 2 + 2)),
        )
    }
})

test('custom stage geometry packs after the double transform and respects interleaved stride', () => {
    const { meshes } = meshesWithoutGpu()
    const origin = 2 ** 40
    const stream = new StageTriangles()
    stream.append(
        new Float64Array([
            origin + 0.125,
            origin + 0.25,
            origin + 2.125,
            origin + 0.25,
            origin + 0.125,
            origin + 3.25,
        ]),
        0x83b6d0,
        0.16,
    )
    const mesh = meshes.draw(stream.vertices, [4, 0, 0, -8, -4 * origin, 8 * origin])
    const buffer = mesh.geometry.getBuffer('aPosition')
    try {
        assert.equal(mesh.batched, false)
        assert.equal(mesh.geometry.topology, 'triangle-list')
        assert.equal(mesh.geometry.getIndex(), undefined)
        assert.equal(mesh.geometry.vertexCount, 3)
        assert.equal(mesh.geometry.buffers.length, 1)
        assert.equal(mesh.geometry.getBuffer('aColor'), buffer)
        const data = buffer.data
        assert.deepEqual(
            [data[0], data[1], data[6], data[7], data[12], data[13]],
            [0.5, -2, 8.5, -2, 0.5, -26],
        )
        assert.deepEqual(
            [mesh.bounds.minX, mesh.bounds.minY, mesh.bounds.maxX, mesh.bounds.maxY],
            [0.5, -26, 8.5, -2],
        )
        const packed = Array.from(data)
        stream.vertices.fill(999)
        assert.deepEqual(Array.from(buffer.data), packed, 'queued geometry owns its source copy')
    } finally {
        meshes.destroy()
    }
})

test('stage mesh recycling frees each buffer once and retains the shared shader', () => {
    const { meshes, shader } = meshesWithoutGpu()
    const stream = new StageTriangles()
    stream.append(triangle(), 0xffffff, 1)
    const first = meshes.draw(stream.vertices, [1, 0, 0, 1, 0, 0])
    const second = meshes.draw(stream.vertices, [1, 0, 0, 1, 10, 20])
    let firstBufferDestroyed = 0
    let secondBufferDestroyed = 0
    let shaderDestroyed = 0
    first.geometry.getBuffer('aPosition').on('destroy', () => firstBufferDestroyed++)
    second.geometry.getBuffer('aPosition').on('destroy', () => secondBufferDestroyed++)
    shader.on('destroy', () => shaderDestroyed++)
    meshes.recycle(first)
    meshes.recycle(first)
    assert.equal(firstBufferDestroyed, 1)
    assert.equal(secondBufferDestroyed, 0)
    assert.equal(shaderDestroyed, 0)
    assert.equal(second.geometry.vertexCount, 3)
    meshes.destroy()
    meshes.destroy()
    assert.equal(secondBufferDestroyed, 1)
    assert.equal(shaderDestroyed, 1)
})

test('context queues stage meshes through its current clip parent and recycles their ownership', () => {
    const { meshes } = meshesWithoutGpu()
    const parent = new Container()
    let mutations = 0
    let waveformRecycles = 0
    const state = { matrix: [2, 0, 0, 3, 10, 20], globalAlpha: 0.3 }
    const context = Object.assign(Object.create(WebGLDrawContext.prototype) as object, {
        state,
        stageMeshes: meshes,
        mutate: () => {
            mutations++
            return true
        },
        parent: () => parent,
        retained: new Map(),
        retainedNoteBodies: new Map(),
        waveforms: { recycle: () => waveformRecycles++ },
    }) as unknown as WebGLDrawContext
    const stream = new StageTriangles()
    stream.append(triangle(), 0xffffff, 0.65)
    try {
        context.drawStageTriangles([])
        assert.equal(mutations, 0)
        context.drawStageTriangles(stream.vertices)
        assert.equal(parent.children.length, 1)
        assert.equal(mutations, 1)
        const before = structuredClone(state)
        ;(context as unknown as { recycleNodes(container: Container): void }).recycleNodes(parent)
        assert.equal(parent.children.length, 0)
        assert.equal(waveformRecycles, 0)
        assert.deepEqual(state, before)
        Object.assign(context, { mutate: () => false })
        context.drawStageTriangles(stream.vertices)
        assert.equal(parent.children.length, 0)
    } finally {
        meshes.destroy()
        parent.destroy()
    }
})

test('retained stage meshes survive frame recycling and are freed once by release or disposal', () => {
    const { meshes } = meshesWithoutGpu()
    const parent = new Container()
    const context = Object.assign(Object.create(WebGLDrawContext.prototype) as object, {
        state: { matrix: [2, 0, 0, 3, 10, 20], globalAlpha: 1 },
        stageMeshes: meshes,
        mutate: () => true,
        parent: () => parent,
        flush: () => {
            ;(context as unknown as { recycleNodes(container: Container): void }).recycleNodes(
                parent,
            )
        },
        retained: new Map(),
        retainedNoteBodies: new Map(),
        waveforms: { recycle: () => {} },
    }) as unknown as WebGLDrawContext
    const stream = new StageTriangles()
    stream.append(triangle(), 0xffffff, 1)
    const kept = context.createStageMesh(stream.vertices, [2, 0, 0, 3, 0, -6])
    const freed = context.createStageMesh(stream.vertices, [1, 0, 0, 1, 0, 0])
    let keptDestroyed = 0
    let freedDestroyed = 0
    kept.geometry.getBuffer('aPosition').on('destroy', () => keptDestroyed++)
    freed.geometry.getBuffer('aPosition').on('destroy', () => freedDestroyed++)
    try {
        // Packed with its own matrix, positioned in device pixels, not the current transform.
        assert.deepEqual(Array.from(kept.geometry.getBuffer('aPosition').data.slice(0, 2)), [0, -6])
        context.drawStageMesh(kept, 12.5, -3.25)
        assert.deepEqual([kept.position.x, kept.position.y], [12.5, -3.25])
        assert.equal(kept.parent, parent)
        ;(context as unknown as { recycleNodes(container: Container): void }).recycleNodes(parent)
        assert.equal(kept.parent, null)
        assert.equal(keptDestroyed, 0, 'a frame never frees a retained mesh')
        context.drawStageMesh(kept, 0, 0)
        context.drawStageMesh(freed, 0, 0)
        // A queued mesh is submitted before it is freed.
        context.releaseStageMesh(freed)
        context.releaseStageMesh(freed)
        assert.equal(freedDestroyed, 1)
        assert.equal(parent.children.length, 0)
        meshes.destroy()
        assert.equal(keptDestroyed, 1)
    } finally {
        meshes.destroy()
        parent.destroy()
    }
})

type Paint = { kind: 'mesh' | 'fill' | 'stroke'; data: number[]; alpha?: number }

const stageProps = (left = -2, right = 2, pivot = 0, borders = 1) => ({
    left,
    right,
    pivotLane: pivot,
    xLaneTranslate: 0,
    laneAlpha: 1,
    fullWidth: 0,
    divisionLineAlpha: 1,
    division: { start: { size: 2, parity: 0 }, end: { size: 2, parity: 0 }, progress: 0 },
    leftBorderStyle: { start: borders, end: borders, progress: 0 },
    rightBorderStyle: { start: borders, end: borders, progress: 0 },
})

function stageContext(stages: ((beat: number) => ReturnType<typeof stageProps>)[]) {
    const paints: Paint[] = []
    let path: number[] = []
    const saved: {
        globalAlpha: number
        lineWidth: number
        strokeStyle: string
        fillStyle: string
    }[] = []
    const ctx = {
        lineCap: 'butt',
        globalCompositeOperation: 'source-over',
        globalAlpha: 0.3,
        lineWidth: 7,
        strokeStyle: '#000',
        fillStyle: '#000',
        getLineDash: () => [] as number[],
        getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
        drawStageTriangles(data: readonly number[]) {
            if (data.length) paints.push({ kind: 'mesh', data: [...data] })
        },
        save() {
            saved.push({
                globalAlpha: this.globalAlpha,
                lineWidth: this.lineWidth,
                strokeStyle: this.strokeStyle,
                fillStyle: this.fillStyle,
            })
        },
        restore() {
            Object.assign(this, saved.pop())
        },
        beginPath() {
            path = []
        },
        moveTo(x: number, y: number) {
            path.push(x, y)
        },
        lineTo(x: number, y: number) {
            path.push(x, y)
        },
        closePath() {},
        clip() {},
        fill() {
            paints.push({ kind: 'fill', data: [...path], alpha: this.globalAlpha })
        },
        stroke() {
            paints.push({ kind: 'stroke', data: [...path], alpha: this.globalAlpha })
        },
    }
    const context = {
        ctx,
        scale: 25,
        ups: -1,
        pixelRatio: 1,
        bounds: { l: -10, r: 10, t: -1, b: 0, w: 20, h: 1 },
        state: { bpms: [{ x: 0, y: 0, s: 1, meter: 4, measure: 0, measureBeat: 0 }] },
        composed: {
            stages: new Map(
                stages.map((_, index) => [index, { startBeat: 0, endBeat: 1, breakpoints: [] }]),
            ),
            stage: (id: number, beat: number) => stages[id]?.(beat),
            gridOffset: () => 0,
        },
    } as unknown as EditorDrawContext
    return { context, ctx, paints }
}

test('stage stream keeps fill, guide, division, and border paint order without leaking state', () => {
    const { context, ctx, paints } = stageContext([() => stageProps()])
    drawComposedStages(context, { min: 0, max: 1 }, fullScope, 1)
    assert.equal(paints.length, 1)
    assert.equal(paints[0]?.kind, 'mesh')
    const data = paints[0]?.data ?? []
    const alphas: number[] = []
    for (let i = 5; i < data.length; i += 6) {
        const alpha = data[i]
        if (alpha !== undefined && alphas.at(-1) !== alpha) alphas.push(alpha)
    }
    assert.deepEqual(alphas, [0.16, 0.1, 0.4, 0.65])
    assert.equal(ctx.globalAlpha, 0.3)
    assert.equal(ctx.lineWidth, 7)
    assert.equal(ctx.strokeStyle, '#000')
})

test('overlapping divider coverage falls back the whole slice in painter order', () => {
    const { context, paints } = stageContext([
        () => stageProps(-6, -4, -5),
        (beat) => stageProps(-2, 2, beat * 1000),
        () => stageProps(4, 6, 5),
    ])
    drawComposedStages(context, { min: 0, max: 1 }, fullScope, 1)
    const meshes = paints.filter((paint) => paint.kind === 'mesh')
    assert.equal(meshes.length, 2, 'unsupported slice must not leave its partial triangle paint')
    assert.equal(paints[0]?.kind, 'mesh')
    assert.equal(paints.at(-1)?.kind, 'mesh')
    assert.ok(paints.slice(1, -1).some((paint) => paint.kind === 'fill'))
    assert.ok(paints.slice(1, -1).every((paint) => paint.kind !== 'mesh'))
    assert.ok(meshes[0]?.data.every((value, index) => index % 6 || value < -3))
    assert.ok(meshes[1]?.data.every((value, index) => index % 6 || value > 3))
})

test('unsupported inherited cap, compositing, and dash modes keep the ordinary path', () => {
    for (const mode of ['cap', 'blend', 'dash']) {
        const { context, ctx, paints } = stageContext([() => stageProps()])
        if (mode === 'cap') ctx.lineCap = 'round'
        if (mode === 'blend') ctx.globalCompositeOperation = 'destination-out'
        if (mode === 'dash') ctx.getLineDash = () => [1, 2]
        drawComposedStages(context, { min: 0, max: 1 }, fullScope, 1)
        assert.ok(paints.some((paint) => paint.kind === 'fill'))
        assert.ok(paints.every((paint) => paint.kind !== 'mesh'))
        assert.equal(ctx.globalAlpha, 0.3)
        assert.equal(ctx.lineWidth, 7)
    }
})

test('unsafe divider indices retain one native coverage union instead of repeated mesh paint', () => {
    const { context, paints } = stageContext([() => stageProps(-2, 2, 2 ** 54, 2)])
    drawComposedStages(context, { min: 0, max: 1 }, fullScope, 1)
    assert.equal(paints[0]?.kind, 'fill')
    assert.ok(paints.every((paint) => paint.kind !== 'mesh'))
    assert.ok(
        paints.some((paint) => {
            if (paint.kind !== 'stroke') return false
            const seen = new Set<string>()
            for (let index = 0; index < paint.data.length; index += 4) {
                const segment = paint.data.slice(index, index + 4).join(',')
                if (seen.has(segment)) return true
                seen.add(segment)
            }
            return false
        }),
        'adversarial indices must actually repeat a stroked segment',
    )
})

test('stage packing guard accepts rebased world coordinates and rejects non-finite or wide device bounds', () => {
    const origin = 2 ** 40
    const rebased = new StageTriangles([4, 0, 0, -8, -4 * origin, 8 * origin])
    assert.equal(rebased.supportsBounds(origin, origin, origin + 2, origin + 3), true)
    const ordinary = new StageTriangles()
    assert.equal(ordinary.supportsBounds(-100, -200, 16000, 16000), true)
    assert.equal(ordinary.supportsBounds(-1, -1, 200000, 1), false)
    assert.equal(ordinary.supportsBounds(-1, -Infinity, 1, 1), false)
    assert.equal(ordinary.supportsBounds(NaN, 0, 1, 1), false)
})

test('stage packing fallback preserves preceding and following triangle batches', () => {
    const { context, paints } = stageContext([
        () => stageProps(-6, -4, -5),
        () => stageProps(-2, 200000),
        () => stageProps(4, 6, 5),
    ])
    drawComposedStages(context, { min: 0, max: 1 }, fullScope, 1)
    const meshes = paints.filter((paint) => paint.kind === 'mesh')
    assert.equal(meshes.length, 2)
    assert.equal(paints[0]?.kind, 'mesh')
    assert.equal(paints.at(-1)?.kind, 'mesh')
    assert.ok(paints.slice(1, -1).some((paint) => paint.kind === 'fill'))
    assert.ok(paints.slice(1, -1).every((paint) => paint.kind !== 'mesh'))
    assert.ok(meshes[0]?.data.every((value, index) => index % 6 || value < -3))
    assert.ok(meshes[1]?.data.every((value, index) => index % 6 || value > 3))
})
