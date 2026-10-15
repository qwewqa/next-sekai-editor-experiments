import assert from 'node:assert/strict'
import test from 'node:test'
import type { StageId } from '../../src/chart/stages'
import { createStageSurface } from '../../src/editor/canvas/stageSurface'
import type { EditorDrawContext } from '../../src/editor/canvas/types'
import { fullScope } from '../../src/editor/scopeRules'

test('stage cache is lazy, bounded and releases lost or unused backing stores', (t) => {
    const allocated: ReturnType<typeof canvas>[] = []
    const resourceOwner = {}
    const canvas = (width = 0, height = 0) => {
        const item = {
            width,
            height,
            lost: false,
            clears: 0,
            blits: 0,
            ctx: {
                globalAlpha: 1,
                isReady: true,
                save() {},
                restore() {},
                setTransform() {},
                resourceOwner,
                maxSurfaceSize: 4096,
                createStageSurface(width: number, height: number): unknown {
                    const surface = canvas(width, height)
                    allocated.push(surface)
                    return surface
                },
                clear() {
                    item.clears++
                },
                clearRect() {
                    item.clears++
                },
                flush() {},
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
            dispose() {
                item.width = item.height = 0
            },
        }
        return item
    }
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
    t.after(() => surface.clear())
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
    draw()
    assert.equal(allocated.length, 4, 'a healthy WebGL surface is reused')
    context.composed = undefined
    draw()
    assert.deepEqual([allocated[3]!.width, allocated[3]!.height], [0, 0])
    assert.equal(allocated.length, 4)
})

test('a motion window is released after an exact last moving frame', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let now = 0
    let renderMs = 0
    let releaseAt = 0
    const schedule = setTimeout
    t.mock.method(globalThis, 'setTimeout', (callback: () => void, delay?: number) => {
        releaseAt = now + (delay ?? 0)
        return schedule(callback, delay)
    })
    t.mock.method(performance, 'now', () => now)
    const allocated: { width: number; height: number }[] = []
    const resourceOwner = {}
    const canvas = (width = 0, height = 0) => {
        const ctx = {
            globalAlpha: 1,
            isReady: true,
            save() {},
            restore() {},
            setTransform() {},
            resourceOwner,
            maxSurfaceSize: 4096,
            createStageSurface(width: number, height: number): unknown {
                const surface = canvas(width, height)
                allocated.push(surface)
                return surface
            },
            clear() {},
            clearRect() {},
            flush() {},
            drawImage() {
                // A GPU surface's queued stage render finishes when it is blitted.
                now += renderMs
            },
            isContextLost: () => false,
        }
        const surface = {
            width,
            height,
            getContext: () => ctx,
            ctx,
            dispose() {
                surface.width = surface.height = 0
            },
        }
        return surface
    }
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
    t.after(() => surface.clear())
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
    const slow = allocated.at(-1)!

    // Speeding past what a window holds releases it at once, not seconds after the motion.
    assert.equal(draw(6040, -0.65), true)
    assert.equal(draw(6050, 0.45), true)
    assert.equal(draw(6060, 1.55), true)
    assert.ok(slow.height > 0)
    assert.equal(draw(6070, 2.65), false)
    assert.deepEqual([slow.width, slow.height], [0, 0])
    assert.equal(draw(6080, 3.75), false)
    assert.equal(allocated.length, count + 1)

    // Cold complex stages can exceed the motion gap. That rendering time must
    // not turn every successive input frame into an isolated exact redraw.
    surface.clear()
    renderMs = 250
    assert.equal(draw(8000, -4), false)
    assert.equal(draw(now + 16, -4.01), false, 'the first move still draws exactly')
    assert.equal(draw(now + 16, -4.02), true, 'slow consecutive frames warm the window')
    assert.equal(draw(now + 16, -4.03), true, 'the next slow frame reuses shifted pixels')
    assert.equal(draw(now + 101, -4.04), false, 'an actual idle gap still draws exactly')
    assert.equal(draw(now + 16, -4.04), false, 'a settled view draws exactly')
    renderMs = 3000
    assert.equal(draw(now + 16, -4.05), false)
    assert.equal(draw(now + 16, -4.06), true)
    assert.equal(releaseAt, now + 2500, 'window expiry starts after even a 3-second render')
    surface.clear()
    renderMs = 0
    const slowFrame = (top: number) => {
        const shifted = draw(now + 16, top)
        now += 250 // The rest of the chart, after stages.draw, can also be slow.
        surface.finishFrame()
        return shifted
    }
    assert.equal(slowFrame(-4), false)
    assert.equal(slowFrame(-4.01), false)
    assert.equal(slowFrame(-4.02), true, 'slow remaining chart work is not an idle gap')
    assert.equal(draw(now + 101, -4.03), false, 'real idle time after the full frame stays exact')
})
