import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createLabelSprites } from '../../src/editor/canvas/labelSprites'
import { blendOverChart } from '../../src/editor/canvas/nameColors'
import { createNameLayer, drawName, placeNames, type NameFill } from '../../src/editor/canvas/names'
import type { EditorDrawContext } from '../../src/editor/canvas/types'
import type { Entity } from '../../src/state/entities'

type Matrix = { a: number; b: number; c: number; d: number; e: number; f: number }
const identity: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }

type Call = { op: string; args: unknown[]; transform: Matrix; clips: string[]; alpha: number }

// Records drawing with the transform and clips in force. Every glyph is 0.5 em
// wide, its ink 0.75 em above the baseline and 0.25 em below.
class RecordingContext {
    font = '10px sans-serif'
    fontKerning = 'auto'
    textBaseline = 'alphabetic'
    textAlign = 'start'
    fillStyle = '#000'
    globalAlpha = 1
    transform = identity
    clips: string[] = []
    stack: { transform: Matrix; clips: string[]; alpha: number }[] = []
    calls: Call[] = []
    constructor(readonly canvas: TestCanvas) {}
    record(op: string, ...args: unknown[]) {
        const { transform, clips, globalAlpha: alpha } = this
        this.calls.push({ op, args, transform, clips: [...clips], alpha })
    }
    save() {
        this.stack.push({
            transform: this.transform,
            clips: [...this.clips],
            alpha: this.globalAlpha,
        })
    }
    restore() {
        const state = this.stack.pop()
        if (state) {
            this.transform = state.transform
            this.clips = state.clips
            this.globalAlpha = state.alpha
        }
    }
    getTransform() {
        return { ...this.transform }
    }
    setTransform(...args: [Matrix] | number[]) {
        const [a, b, c, d, e, f] = args as number[]
        this.transform =
            typeof args[0] === 'object'
                ? { ...args[0] }
                : { a: a!, b: b!, c: c!, d: d!, e: e!, f: f! }
    }
    translate(x: number, y: number) {
        const { a, b, c, d, e, f } = this.transform
        this.transform = { a, b, c, d, e: e + a * x, f: f + d * y }
    }
    scale(x: number, y: number) {
        const { a, b, c, d, e, f } = this.transform
        this.transform = { a: a * x, b, c, d: d * y, e, f }
    }
    clip(path: { name: string }, rule?: string) {
        this.clips.push(`${rule === 'evenodd' ? 'out' : 'in'}:${path.name}`)
    }
    measureText(text: string) {
        const size = parseFloat(this.font)
        const width = text.length * 0.5 * size
        const left =
            this.textAlign === 'center' ? width / 2 : /end|right/.test(this.textAlign) ? width : 0
        return {
            width,
            actualBoundingBoxLeft: left,
            actualBoundingBoxRight: width - left,
            actualBoundingBoxAscent: 0.75 * size,
            actualBoundingBoxDescent: 0.25 * size,
        }
    }
    fillText(text: string, x: number, y: number) {
        this.record('fillText', text, x, y, this.fillStyle, this.font, this.textAlign)
    }
    drawImage(image: TestCanvas, x: number, y: number) {
        this.record('drawImage', image, x, y)
    }
}

class TestCanvas {
    width = 300
    height = 150
    lang = ''
    context = new RecordingContext(this)
    getContext() {
        return this.context
    }
}

class TestPath {
    static count = 0
    name = `p${TestPath.count++}`
    added: TestPath[] = []
    rect() {}
    addPath(path: TestPath) {
        this.added.push(path)
        this.name = this.added.map(({ name }) => name).join('+')
    }
}

const installGlobal = (t: TestContext, name: string, value: unknown) => {
    const original = Object.getOwnPropertyDescriptor(globalThis, name)
    Object.defineProperty(globalThis, name, { configurable: true, value })
    t.after(() => {
        if (original) Object.defineProperty(globalThis, name, original)
        else Reflect.deleteProperty(globalThis, name)
    })
}

// A pane of 10 CSS px per lane at the given device pixel ratio, its origin off the pixel grid.
const scene = (t: TestContext, pixelRatio = 1, lang = 'en') => {
    const created: TestCanvas[] = []
    installGlobal(t, 'Path2D', TestPath)
    installGlobal(t, 'document', {
        documentElement: { lang },
        createElement: () => {
            const canvas = new TestCanvas()
            created.push(canvas)
            return canvas
        },
    })
    const target = new TestCanvas()
    const ctx = target.context
    const scale = 10
    ctx.setTransform(scale * pixelRatio, 0, 0, scale * pixelRatio, 0.3, 0.6)
    const sprites = createLabelSprites()
    const context = {
        ctx: ctx as unknown as CanvasRenderingContext2D,
        scale,
        pixelRatio,
        bounds: { l: -50, r: 50, t: -50, b: 50, w: 100, h: 100 },
        fontFamily: 'sans-serif',
        fontMiddle: 0.25,
        nameContrast: false,
        nameSprites: sprites,
    } as unknown as EditorDrawContext
    // Sprites the cache holds, not counting the shared measuring canvas.
    const sprite = (image: unknown) => image as TestCanvas
    return { context, ctx, sprites, created, sprite }
}

const owner = { type: 'note' } as Entity
const queue = (context: EditorDrawContext, names: [string, number, number, string?][]) => {
    const layer = createNameLayer()
    for (const [text, x, y, color = '#f6f'] of names)
        layer.names.push({
            owner,
            highlighted: false,
            text,
            x,
            y,
            color,
            size: 0.4,
            align: 'center',
            alpha: 1,
        })
    return layer
}

test('a name is rasterised once, then copied to the device pixel nearest its anchor', (t) => {
    const { context, ctx, sprites, created, sprite } = scene(t)
    for (const frame of [1, 2]) {
        sprites.beginFrame(frame)
        placeNames(context, queue(context, [['Stage', 1.23, 2.34]]))
    }
    const draws = ctx.calls.filter(({ op }) => op === 'drawImage')
    assert.equal(draws.length, 2)
    // One sprite, plus the canvas that measures them.
    assert.equal(created.length, 2)
    const image = sprite(draws[0]!.args[0])
    assert.equal(draws[1]!.args[0], image)
    // Text 4 px tall and 10 px wide about its anchor at (12.6, 24.0), padded by 2 px.
    const [text] = image.context.calls
    assert.deepEqual(text?.args, ['Stage', 0, 1, '#f6f', '4px sans-serif', 'center'])
    assert.deepEqual(text?.transform, { a: 1, b: 0, c: 0, d: 1, e: 7, f: 4 })
    assert.deepEqual([image.width, image.height], [14, 8])
    for (const { args, transform } of draws) {
        assert.deepEqual(transform, identity)
        assert.deepEqual(args.slice(1), [13 - 7, 24 - 4])
    }
    // Nothing was drawn as text on the pane.
    assert.equal(ctx.calls.filter(({ op }) => op === 'fillText').length, 0)
    assert.deepEqual(ctx.transform, { a: 10, b: 0, c: 0, d: 10, e: 0.3, f: 0.6 })
})

test('names look the same at the device scale: sprites are drawn as drawText shapes them', (t) => {
    const { context, ctx, sprites, sprite } = scene(t, 1.25)
    sprites.beginFrame(1)
    placeNames(context, queue(context, [['Stage', 0, 0]]))
    const [draw] = ctx.calls.filter(({ op }) => op === 'drawImage')
    const [text] = sprite(draw?.args[0]).context.calls
    // A 4 px font, rasterised at 1.25 device pixels per CSS pixel.
    assert.equal(text?.args[4], '4px sans-serif')
    assert.equal(text?.transform.a, 1.25)
    assert.equal(text?.transform.d, 1.25)
})

test('a new text, colour, size, font, device scale or language makes a new sprite', (t) => {
    const { context, sprites, created } = scene(t)
    let frame = 0
    const draw = (overrides: Partial<EditorDrawContext> = {}, color = '#f6f', text = 'Stage') => {
        sprites.beginFrame(++frame)
        const at = { ...context, ...overrides }
        placeNames(at, queue(at, [[text, 0, 0, color]]))
    }
    draw()
    draw()
    assert.equal(created.length, 2)
    draw({}, '#a0a')
    draw({}, '#f6f', 'Group')
    draw({ fontFamily: 'serif' })
    // A wider pane: a larger font for the same lanes, once the scale holds a frame.
    draw({ scale: 20 })
    draw({ scale: 20 })
    assert.equal(created.length, 6)
    context.ctx.setTransform(20, 0, 0, 20, 0, 0)
    draw()
    draw()
    assert.equal(created.length, 7)
    ;(
        globalThis as unknown as { document: { documentElement: { lang: string } } }
    ).document.documentElement.lang = 'ja'
    draw()
    assert.equal(created.length, 8)
    assert.equal(created.at(-1)?.lang, 'ja')
    // Drawing it again reuses it.
    draw()
    assert.equal(created.length, 8)
})

test('while the scale changes every frame, as in a pinch zoom, new names draw as text', (t) => {
    const { context, ctx, sprites, created } = scene(t)
    let frame = 0
    const draw = (scale: number, pixelRatio = 1, text = 'Stage') => {
        sprites.beginFrame(++frame)
        ctx.calls = []
        ctx.setTransform(scale * pixelRatio, 0, 0, scale * pixelRatio, 0.3, 0.6)
        const at = { ...context, scale }
        // The chart and its overlay share a frame.
        placeNames(at, queue(at, [[text, 0, 0]]))
        placeNames(at, queue(at, [[text, 0, 2]]))
        const op = (name: string) => ctx.calls.filter((call) => call.op === name).length
        return { sprites: op('drawImage'), text: op('fillText') }
    }
    // The first frame rasterises at once.
    assert.deepEqual(draw(10), { sprites: 2, text: 0 })
    assert.equal(created.length, 2)
    // Each frame at a new scale draws text, as drawText would, and makes no sprite.
    for (const scale of [11, 12, 13]) assert.deepEqual(draw(scale), { sprites: 0, text: 2 })
    assert.equal(created.length, 2)
    // A scale it already holds a sprite for still draws from it.
    assert.deepEqual(draw(10), { sprites: 2, text: 0 })
    // Once the scale holds a frame, as on the next still frame, the name rasterises.
    assert.deepEqual(draw(14), { sprites: 0, text: 2 })
    assert.deepEqual(draw(14), { sprites: 2, text: 0 })
    assert.equal(created.length, 3)
    // The same for a device scale change, which keeps the font size.
    assert.deepEqual(draw(14, 1.25), { sprites: 0, text: 2 })
    assert.deepEqual(draw(14, 1.25), { sprites: 2, text: 0 })
    // A new text at a scale that holds rasterises at once.
    assert.deepEqual(draw(14, 1.25, 'Group'), { sprites: 2, text: 0 })
    assert.equal(created.length, 5)
})

test('clearing releases every sprite', (t) => {
    const { context, sprites, created } = scene(t)
    sprites.beginFrame(1)
    placeNames(
        context,
        queue(context, [
            ['Stage', 0, 0],
            ['Group', 0, 5],
        ]),
    )
    sprites.clear()
    assert.ok(created.slice(1).every(({ width, height }) => !width && !height))
    sprites.beginFrame(2)
    placeNames(context, queue(context, [['Stage', 0, 0]]))
    assert.equal(created.length, 5)
})

test('the cache keeps the frame drawing its names, and draws past its bounds as text', (t) => {
    const { context, ctx, sprites, created } = scene(t)
    const names = Array.from({ length: 1100 }, (_, index) => `${index}` as const)
    sprites.beginFrame(1)
    placeNames(
        context,
        queue(
            context,
            names.map((text) => [text, 0, 0]),
        ),
    )
    // 1024 sprites, the rest as text.
    assert.equal(created.length, 1025)
    assert.equal(ctx.calls.filter(({ op }) => op === 'drawImage').length, 1024)
    const texts = ctx.calls.filter(({ op }) => op === 'fillText')
    assert.equal(texts.length, 76)
    // Drawn as drawText does, under the pane's transform.
    assert.equal(texts[0]?.transform.a, 1)
    assert.equal(texts[0]?.transform.e, 0.3)
    // A later frame replaces the least recently used.
    ctx.calls = []
    sprites.beginFrame(2)
    placeNames(
        context,
        queue(context, [
            ['new', 0, 0],
            ['5', 0, 0],
        ]),
    )
    assert.equal(created.length, 1026)
    assert.equal(created[1]!.width, 0)
    assert.equal(ctx.calls.filter(({ op }) => op === 'drawImage').length, 2)
})

test('a split name clips in the scene and draws each colour from its sprite', (t) => {
    const { context, ctx, sprites, sprite } = scene(t)
    const path = new TestPath()
    const fill: NameFill = {
        box: { l: -10, r: 10, t: -1, b: 6 },
        shapes: () => [path as unknown as Path2D],
        colorsAt: () => [blendOverChart('#7fffd3', 0.8)],
    }
    const layer = queue(context, [['Stage', 0, 0]])
    layer.fills.push(fill)
    sprites.beginFrame(1)
    placeNames({ ...context, nameContrast: true }, layer)
    const draws = ctx.calls.filter(({ op }) => op === 'drawImage')
    assert.deepEqual(
        draws.map(({ args, clips, transform }) => ({
            color: sprite(args[0]).context.calls[0]?.args[3],
            clips,
            transform,
        })),
        [
            { color: '#f6f', clips: [`out:${path.name}`], transform: identity },
            { color: '#808', clips: [`in:${path.name}`], transform: identity },
        ],
    )
})

test('a name drawn at once, as on a paste ghost, also comes from its sprite', (t) => {
    const { context, ctx, sprites } = scene(t)
    sprites.beginFrame(1)
    drawName(context, owner, true, 'Stage', 1.23, 2.34, '#f6f')
    const draws = ctx.calls.filter(({ op }) => op === 'drawImage')
    assert.equal(draws.length, 1)
    assert.deepEqual(draws[0]?.args.slice(1), [13 - 7, 24 - 4])
    assert.deepEqual(ctx.transform, { a: 10, b: 0, c: 0, d: 10, e: 0.3, f: 0.6 })
})
