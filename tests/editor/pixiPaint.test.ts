import assert from 'node:assert/strict'
import test from 'node:test'
import { FillGradient, GraphicsContext, MeshGeometry, type FillInput } from 'pixi.js'
import { DrawGradient } from '../../src/rendering/paint'
import { meshPaint, PaintStyles, retainPaint, scalePaint } from '../../src/rendering/pixiPaint'

const fade = (end = 100, color = '#ff800080') => {
    const gradient = new DrawGradient([0, 0], [0, end])
    gradient.addColorStop(0, color)
    gradient.addColorStop(1, `${color.slice(0, 7)}00`)
    return gradient
}

const fillGradient = (style: FillInput) => {
    assert.ok(typeof style === 'object' && style && 'fill' in style)
    assert.ok(style.fill instanceof FillGradient)
    return style.fill
}

test('equivalent fades share tiny ramps while their axes retain independent transforms', () => {
    const paints = new PaintStyles()
    const a = paints.fill(fade(100))
    const same = paints.fill(fade(100))
    const b = paints.fill(fade(200))
    const first = fillGradient(a.style)
    const second = fillGradient(b.style)
    assert.equal(a.key, same.key)
    assert.notEqual(a.key, b.key)
    assert.equal(first.texture, second.texture)
    assert.equal(first.texture.width, 2)
    const point = (gradient: FillGradient, x: number) => {
        const { x: px, y } = gradient.transform.apply({ x, y: 0 })
        return [px, y]
    }
    assert.deepEqual(point(first, 0.5), [0, 0])
    assert.deepEqual(point(first, 1.5), [0, 100])
    assert.deepEqual(point(second, 1.5), [0, 200])
    paints.destroy()
    assert.equal(first.texture.destroyed, true)
})

test('gradient mutation changes the style without changing previously queued paints', () => {
    const paints = new PaintStyles()
    const source = fade()
    const before = paints.fill(source)
    const context = new GraphicsContext()
    retainPaint(context, before.style)
    source.addColorStop(0.5, '#fff')
    const after = paints.fill(source)
    assert.notEqual(before.key, after.key)
    assert.notEqual(fillGradient(before.style).texture, fillGradient(after.style).texture)
    assert.equal(fillGradient(before.style).texture.destroyed, false)
    context.destroy()
    paints.destroy()
})

test('ramp eviction preserves retained contexts and rebuilds expired weak metadata', () => {
    const paints = new PaintStyles()
    const source = fade()
    const first = paints.fill(source)
    const texture = fillGradient(first.style).texture
    const context = new GraphicsContext()
    retainPaint(context, first.style)
    const textures = []
    for (let i = 0; i < 400; i++) {
        const color = `#${i.toString(16).padStart(6, '0')}80`
        textures.push(fillGradient(paints.fill(fade(100, color)).style).texture)
    }
    assert.equal(texture.destroyed, false, 'queued geometry pins its texture')
    assert.ok(textures.filter((value) => !value.destroyed).length <= 255)
    context.destroy()
    paints.fill(fade(100, '#ffffff80'))
    assert.equal(texture.destroyed, true, 'released old ramps can be evicted')
    const restored = fillGradient(paints.fill(source).style).texture
    assert.notEqual(restored, texture)
    assert.equal(restored.destroyed, false)
    paints.destroy()
    assert.ok(textures.every((value) => value.destroyed))
    assert.equal(restored.destroyed, true)
})

test('empty and zero-length gradients are transparent without allocating a texture', () => {
    const paints = new PaintStyles()
    for (const gradient of [new DrawGradient([0, 0], [0, 1]), fade(0)])
        assert.deepEqual(paints.fill(gradient).style, { color: 0, alpha: 0 })
    paints.destroy()
})

test('shared ramps survive until both native paths and meshes release them', () => {
    const paints = new PaintStyles()
    const style = paints.fill(fade()).style
    const texture = fillGradient(style).texture
    const context = new GraphicsContext()
    const geometry = new MeshGeometry({})
    retainPaint(context, style)
    retainPaint(geometry, style)
    const churn = (offset: number) => {
        for (let i = offset; i < offset + 400; i++)
            paints.fill(fade(100, `#${i.toString(16).padStart(6, '0')}80`))
    }
    churn(0)
    assert.equal(texture.destroyed, false)
    context.destroy()
    churn(400)
    assert.equal(texture.destroyed, false, 'the mesh still owns the shared ramp')
    geometry.destroy(true)
    churn(800)
    assert.equal(texture.destroyed, true, 'the last geometry release permits eviction')
    paints.destroy()
})

test('direct mesh paint matches native Graphics normalization for editor paint forms', () => {
    const paints = new PaintStyles()
    const styles = [
        { color: 0xffffff },
        paints.fill('#4080c060').style,
        paints.stroke('#04f8', 0.1, 'butt', 'miter', 10).style,
        paints.fill(fade()).style,
        scalePaint(paints.stroke(fade(), 0.1, 'round', 'round', 10).style, 128),
    ]
    for (const style of styles) {
        const native = new GraphicsContext()
        native.fillStyle = style
        const mesh = meshPaint(style)
        assert.ok(mesh)
        assert.equal(mesh.texture, native.fillStyle.texture)
        assert.equal(mesh.tint, native.fillStyle.color)
        assert.equal(mesh.alpha, native.fillStyle.alpha)
        if (mesh.matrix) {
            assert.ok(native.fillStyle.matrix)
            assert.deepEqual(mesh.matrix.toArray(), native.fillStyle.matrix.toArray())
        }
        native.destroy()
    }
    assert.equal(meshPaint('red'), undefined, 'generic Pixi colors keep the native route')
    paints.destroy()
})

test('resolution-scaled paints share their ramp and preserve the original paint', () => {
    const paints = new PaintStyles()
    const gradient = new DrawGradient([3, 5], [8, 17])
    gradient.addColorStop(0, '#00ff0080')
    gradient.addColorStop(1, '#00ff0000')
    const original = paints.stroke(gradient, 0.05, 'round', 'round', 10).style
    const scaled = scalePaint(original, 128)
    assert.ok(typeof scaled === 'object' && scaled && 'width' in scaled && 'cap' in scaled)
    assert.equal(original.width, 0.05)
    assert.equal(scaled.width, 6.4)
    assert.equal(scaled.cap, 'round')
    const before = fillGradient(original),
        after = fillGradient(scaled)
    assert.notEqual(before, after)
    assert.equal(before.texture, after.texture)
    for (const point of [
        { x: 0.5, y: 0 },
        { x: 1.5, y: 0 },
        { x: 1, y: 4 },
    ]) {
        const old = before.transform.apply(point),
            value = after.transform.apply(point)
        assert.equal(value.x, old.x * 128)
        assert.equal(value.y, old.y * 128)
    }
    const context = new GraphicsContext()
    retainPaint(context, scaled)
    for (let i = 0; i < 400; i++) paints.fill(fade(100, `#${i.toString(16).padStart(6, '0')}80`))
    assert.equal(after.texture.destroyed, false)
    context.destroy()
    paints.destroy()
    assert.equal(after.texture.destroyed, true)
})
