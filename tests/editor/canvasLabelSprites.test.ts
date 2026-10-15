import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createLabelSprites } from '../../src/editor/canvas/labelSprites'
import { createNameLayer, drawName, placeNames } from '../../src/editor/canvas/names'
import type { EditorDrawContext } from '../../src/editor/canvas/types'
import type { WebGLDrawContext } from '../../src/rendering/context'
import { DrawPath } from '../../src/rendering/path'
import type { Entity } from '../../src/state/entities'
import { recordEditorLabel } from './recordedLabel'
import { pathName } from './recordedPath'

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
    strokeStyle = '#000'
    lineWidth = 1
    lineJoin = 'miter'
    globalAlpha = 1
    transform = identity
    clips: string[] = []
    stack: { transform: Matrix; clips: string[]; alpha: number }[] = []
    calls: Call[] = []
    drawEditorLabel = recordEditorLabel
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
    clip(path: DrawPath, rule?: string) {
        this.clips.push(`${rule === 'evenodd' ? 'out' : 'in'}:${pathName(path)}`)
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
    strokeText(text: string, x: number, y: number) {
        this.record(
            'strokeText',
            text,
            x,
            y,
            this.strokeStyle,
            this.font,
            this.textAlign,
            this.lineWidth,
            this.lineJoin,
        )
    }
    drawNameSprite(image: TestCanvas, x: number, y: number) {
        this.record('drawNameSprite', image, x, y)
    }
    releaseImage(image: TestCanvas) {
        this.record('releaseImage', image, image.width, image.height)
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
        ctx: ctx as unknown as WebGLDrawContext,
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
    const draws = ctx.calls.filter(({ op }) => op === 'drawNameSprite')
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
    const [draw] = ctx.calls.filter(({ op }) => op === 'drawNameSprite')
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
        return { sprites: op('drawNameSprite'), text: op('fillText') }
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
    const { context, ctx, sprites, created } = scene(t)
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
    const releases = ctx.calls.filter(({ op }) => op === 'releaseImage')
    assert.deepEqual(
        releases.map(({ args }) => args[0]),
        created.slice(1),
    )
    assert.ok(releases.every(({ args }) => Number(args[1]) > 0 && Number(args[2]) > 0))
    sprites.clear()
    assert.equal(ctx.calls.filter(({ op }) => op === 'releaseImage').length, 2)
    sprites.beginFrame(2)
    placeNames(context, queue(context, [['Stage', 0, 0]]))
    assert.equal(created.length, 5)
})

test('the cache keeps the frame drawing its names, and draws past its bounds as text', (t) => {
    const { context, ctx, sprites, created } = scene(t)
    const names = Array.from({ length: 1100 }, (_, index) => `${index}` as const)
    sprites.beginFrame(1)
    // Selected names stay visible even when overlapping; exercise the cache,
    // independently of ordinary-name decluttering.
    const crowded = queue(
        context,
        names.map((text) => [text, 0, 0]),
    )
    for (const name of crowded.names) name.highlighted = true
    placeNames(context, crowded)
    // 1024 sprites, the rest as text.
    assert.equal(created.length, 1025)
    assert.equal(ctx.calls.filter(({ op }) => op === 'drawNameSprite').length, 1024)
    const texts = ctx.calls.filter(({ op }) => op === 'fillText')
    assert.equal(texts.length, 76)
    // Drawn as drawText does, under the pane's transform.
    assert.equal(texts[0]?.transform.a, 1)
    assert.equal(texts[0]?.transform.e, 0.3)
    // A later frame replaces the least recently used.
    ctx.calls = []
    sprites.beginFrame(2)
    const replacement = queue(context, [
        ['new', 0, 0],
        ['5', 0, 0],
    ])
    for (const name of replacement.names) name.highlighted = true
    placeNames(context, replacement)
    assert.equal(created.length, 1026)
    assert.equal(created[1]!.width, 0)
    assert.equal(ctx.calls.filter(({ op }) => op === 'drawNameSprite').length, 2)
    const releases = ctx.calls.filter(({ op }) => op === 'releaseImage')
    assert.equal(releases.length, 1)
    assert.equal(releases[0]?.args[0], created[1])
    assert.ok(Number(releases[0]?.args[1]) > 0 && Number(releases[0]?.args[2]) > 0)
})

test('shared sprites release images from both pane contexts, once per context', (t) => {
    const { context, ctx, sprites, created } = scene(t)
    const overlay = new TestCanvas().context
    overlay.transform = ctx.transform
    const overlayContext = { ...context, ctx: overlay as unknown as WebGLDrawContext }
    sprites.beginFrame(1)
    for (const at of [context, overlayContext, context, overlayContext])
        placeNames(at, queue(at, [['Stage', 0, 0]]))
    assert.equal(created.length, 2)
    sprites.clear()
    for (const target of [ctx, overlay]) {
        const releases = target.calls.filter(({ op }) => op === 'releaseImage')
        assert.equal(releases.length, 1)
        assert.equal(releases[0]?.args[0], created[1])
        assert.ok(Number(releases[0]?.args[1]) > 0 && Number(releases[0]?.args[2]) > 0)
    }
})

test('replacement consumers release old image ownership without invalidating the sprite', (t) => {
    const { context, ctx, sprites, created } = scene(t)
    const targets = [ctx, ...Array.from({ length: 4 }, () => new TestCanvas().context)]
    sprites.beginFrame(1)
    for (const [index, target] of targets.entries()) {
        target.transform = ctx.transform
        const at = { ...context, ctx: target as unknown as WebGLDrawContext }
        placeNames(at, queue(at, [['Stage', 0, 0]]))
        assert.equal(created.length, 2, 'replacement consumers reuse the same native sprite')
        assert.ok(created[1]!.width > 0 && created[1]!.height > 0)
        for (const [previousIndex, previous] of targets.entries()) {
            const releases = previous.calls.filter(({ op }) => op === 'releaseImage')
            assert.equal(releases.length, previousIndex < index - 1 ? 1 : 0)
        }
    }
    sprites.clear()
    for (const target of targets) {
        const releases = target.calls.filter(({ op }) => op === 'releaseImage')
        assert.equal(releases.length, 1)
        assert.equal(releases[0]?.args[0], created[1])
        assert.ok(Number(releases[0]?.args[1]) > 0 && Number(releases[0]?.args[2]) > 0)
    }
})

for (const pixelRatio of [1, 1.25, 2]) {
    test(`contrast outlines the whole shaped name by half a CSS pixel, with opacity applied once (DPR ${pixelRatio})`, (t) => {
        const { context, ctx, sprites, sprite } = scene(t, pixelRatio)
        const path = new DrawPath()
        path.rect(-10, -1, 20, 7)
        ctx.clip(path)
        ctx.globalAlpha = 0.7
        const layer = queue(context, [
            ['Stage', 0, 0],
            ['Group', 0, 2, '#0aa'],
        ])
        layer.names[0]!.alpha = 0.4
        layer.names[1]!.alpha = 0.6
        sprites.beginFrame(1)
        placeNames({ ...context, nameContrast: true }, layer)
        const draws = ctx.calls.filter(({ op }) => op === 'drawNameSprite')
        assert.equal(draws.length, 2, 'one composite per complete name')
        for (const [index, draw] of draws.entries()) {
            const [stroke, fill] = sprite(draw.args[0]).context.calls
            const text = index ? 'Group' : 'Stage'
            assert.equal(stroke?.op, 'strokeText')
            assert.deepEqual(stroke?.args, [
                text,
                0,
                1,
                '#000',
                '4px sans-serif',
                'center',
                1,
                'round',
            ])
            assert.equal(fill?.op, 'fillText')
            assert.deepEqual(fill?.args, [
                text,
                0,
                1,
                index ? '#0aa' : '#f6f',
                '4px sans-serif',
                'center',
            ])
            assert.equal(stroke?.transform.a, pixelRatio)
            assert.equal(stroke?.transform.d, pixelRatio)
            assert.equal(stroke?.alpha, 1)
            assert.equal(fill?.alpha, 1)
            assert.equal(draw.alpha, index ? 0.6 : 0.4)
            assert.deepEqual(draw.clips, [`in:${pathName(path)}`])
            assert.deepEqual(draw.transform, identity)
        }
        assert.equal(ctx.globalAlpha, 0.7)
        assert.deepEqual(ctx.transform, {
            a: 10 * pixelRatio,
            b: 0,
            c: 0,
            d: 10 * pixelRatio,
            e: 0.3,
            f: 0.6,
        })
        assert.deepEqual(ctx.clips, [`in:${pathName(path)}`])
    })
}

test('toggling contrast selects distinct cached sprites without changing the requested colour', (t) => {
    const { context, ctx, sprites, created, sprite } = scene(t)
    for (const [index, nameContrast] of [false, true, false, true].entries()) {
        sprites.beginFrame(index + 1)
        placeNames({ ...context, nameContrast }, queue(context, [['Group', 0, 0, '#0aa']]))
    }
    const draws = ctx.calls.filter(({ op }) => op === 'drawNameSprite')
    assert.equal(created.length, 3, 'one measurer plus the plain and outlined sprites')
    assert.equal(draws.length, 4)
    assert.notEqual(draws[0]?.args[0], draws[1]?.args[0])
    assert.equal(draws[0]?.args[0], draws[2]?.args[0])
    assert.equal(draws[1]?.args[0], draws[3]?.args[0])
    for (const [index, draw] of draws.slice(0, 2).entries()) {
        const calls = sprite(draw.args[0]).context.calls
        assert.equal(calls.filter(({ op }) => op === 'strokeText').length, index)
        const fills = calls.filter(({ op }) => op === 'fillText')
        assert.equal(fills.length, 1)
        assert.equal(fills[0]?.args[3], '#0aa')
    }
})

test('a name drawn at once, as on a paste ghost, also comes from its sprite', (t) => {
    const { context, ctx, sprites } = scene(t)
    sprites.beginFrame(1)
    drawName(context, owner, true, 'Stage', 1.23, 2.34, '#f6f')
    const draws = ctx.calls.filter(({ op }) => op === 'drawNameSprite')
    assert.equal(draws.length, 1)
    assert.deepEqual(draws[0]?.args.slice(1), [13 - 7, 24 - 4])
    assert.deepEqual(ctx.transform, { a: 10, b: 0, c: 0, d: 10, e: 0.3, f: 0.6 })
})
