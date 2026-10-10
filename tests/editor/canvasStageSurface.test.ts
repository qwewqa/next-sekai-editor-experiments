import assert from 'node:assert/strict'
import test from 'node:test'
import type { StageId } from '../../src/chart/stages'
import { createStageSurface } from '../../src/editor/canvas/stageSurface'
import type { EditorDrawContext } from '../../src/editor/canvas/types'
import { fullScope } from '../../src/editor/scopeRules'

test('stage cache is lazy, bounded and releases lost or unused backing stores', (t) => {
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
    const allocated: ReturnType<typeof canvas>[] = []
    const canvas = () => {
        const item = {
            width: 0,
            height: 0,
            lost: false,
            clears: 0,
            blits: 0,
            ctx: {
                globalAlpha: 1,
                save() {},
                restore() {},
                setTransform() {},
                fillRect() {
                    item.clears++
                },
                drawImage() {
                    item.blits++
                },
                isContextLost() {
                    return item.lost
                },
            },
            getContext() {
                return item.ctx
            },
        }
        return item
    }
    Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: {
            createElement: () => {
                const item = canvas()
                allocated.push(item)
                return item
            },
        },
    })
    t.after(() => {
        if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
        else Reflect.deleteProperty(globalThis, 'document')
    })
    const target = canvas()
    const context = {
        ctx: target.ctx,
        pixelRatio: 1.25,
        scale: 25,
        ups: -2,
        bounds: { l: -4, r: 4, t: -4, b: 0, w: 8, h: 4 },
        state: { bpms: [] },
    } as unknown as EditorDrawContext
    const surface = createStageSurface()
    const draw = (width = 200, height = 100) =>
        surface.draw(context, width, height, { min: 0, max: 8 }, fullScope, 1)
    draw()
    assert.equal(allocated.length, 0, 'Basic never allocates or blits a stage surface')
    assert.equal(target.blits, 0)
    context.composed = {
        // A stage outside this view needs no paths, but still caches transparent
        // pixels. Its lifecycle must be identical to a visible stage bitmap.
        stages: new Map([[1 as StageId, { startBeat: 20, endBeat: 24 }]]),
    } as EditorDrawContext['composed']
    draw()
    assert.equal(allocated.length, 1)
    assert.deepEqual([allocated[0]!.width, allocated[0]!.height], [250, 125])
    const initialClears = allocated[0]!.clears
    context.state = { ...context.state, selectedEntities: [] }
    context.bounds = { ...context.bounds }
    draw()
    assert.equal(allocated[0]!.clears, initialClears, 'equal view reuses its bitmap')
    assert.equal(target.blits, 2)
    allocated[0]!.lost = true
    draw()
    assert.equal(allocated.length, 2)
    assert.deepEqual([allocated[0]!.width, allocated[0]!.height], [0, 0])
    assert.equal(target.blits, 3)
    draw(4096, 4096)
    assert.equal(allocated.length, 2, 'over-budget surfaces draw directly')
    assert.equal(target.blits, 3)
    assert.deepEqual([allocated[1]!.width, allocated[1]!.height], [0, 0])
    draw()
    assert.equal(allocated.length, 3)
    surface.clear()
    assert.deepEqual([allocated[2]!.width, allocated[2]!.height], [0, 0])
    draw()
    assert.equal(allocated.length, 4)
    Reflect.deleteProperty(allocated[3]!.ctx, 'isContextLost')
    draw()
    assert.equal(allocated.length, 4, 'older Canvas APIs still reuse the valid surface')
    context.composed = undefined
    draw()
    assert.deepEqual([allocated[3]!.width, allocated[3]!.height], [0, 0])
    assert.equal(allocated.length, 4)
})

test('a motion window is released after an exact last moving frame', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let now = 0
    t.mock.method(performance, 'now', () => now)
    const allocated: { width: number; height: number }[] = []
    const canvas = () => {
        const ctx = {
            globalAlpha: 1,
            save() {},
            restore() {},
            setTransform() {},
            fillRect() {},
            drawImage() {},
            isContextLost: () => false,
        }
        return { width: 0, height: 0, getContext: () => ctx, ctx }
    }
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
    Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: {
            createElement: () => {
                const item = canvas()
                allocated.push(item)
                return item
            },
        },
    })
    t.after(() => {
        if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
        else Reflect.deleteProperty(globalThis, 'document')
    })
    const context = {
        ctx: canvas().ctx,
        pixelRatio: 1,
        scale: 25,
        ups: -2,
        bounds: { l: -4, r: 4, t: -4, b: 0, w: 8, h: 4 },
        state: { bpms: [{ x: 0, y: 0, s: 1 }] },
        composed: { stages: new Map([[1 as StageId, { startBeat: 20, endBeat: 24 }]]) },
    } as unknown as EditorDrawContext
    const surface = createStageSurface()
    const draw = (time: number, t: number) => {
        now = time
        context.bounds = { ...context.bounds, t, b: t + 4 }
        return surface.draw(context, 200, 100, { min: 0, max: 8 }, fullScope, 1)
    }
    draw(0, -4)
    assert.equal(draw(10, -4.01), false, 'a single step draws exactly')
    assert.equal(draw(20, -4.02), true, 'sustained motion shifts a window')
    const window = allocated.find((item) => item.height > 100)
    assert.ok(window)
    // Spaced past a motion's gap, the last moving frame draws exactly and nothing draws after it.
    assert.equal(draw(200, -4.03), false)
    t.mock.timers.tick(2499)
    assert.ok(window.height > 0, 'kept through a pause')
    t.mock.timers.tick(1)
    assert.deepEqual([window.width, window.height], [0, 0])

    // A window first drawn on the last moving frame is released too, with no draw after it.
    draw(3000, -4.03)
    draw(3010, -4.04)
    assert.equal(draw(3020, -4.05), true)
    const last = allocated.filter((item) => item.height > 100).at(-1)!
    assert.notEqual(last, window)
    t.mock.timers.tick(2500)
    assert.deepEqual([last.width, last.height], [0, 0])

    // A window reaches a view ahead: motion that crosses it within four frames draws exactly.
    const count = allocated.length
    draw(6000, -4.05)
    draw(6010, -2.95)
    assert.equal(draw(6020, -1.85), false)
    assert.equal(allocated.length, count)
    // Slower motion still shifts a window.
    assert.equal(draw(6030, -1.75), true)
    assert.equal(allocated.length, count + 1)
})
