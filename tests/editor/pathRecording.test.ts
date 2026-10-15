import assert from 'node:assert/strict'
import test from 'node:test'
import { DrawPath } from '../../src/rendering/path'

test('recorded geometry needs no browser or renderer initialization', () => {
    const path = new DrawPath('M1 2L3 4')
    path.moveTo(5, 6)
    path.lineTo(7, 8)
    path.quadraticCurveTo(9, 10, 11, 12)
    path.bezierCurveTo(13, 14, 15, 16, 17, 18)
    path.closePath()
    assert.deepEqual(path.commands, [
        ['svg', 'M1 2L3 4'],
        ['moveTo', 5, 6],
        ['lineTo', 7, 8],
        ['quadraticCurveTo', 9, 10, 11, 12],
        ['bezierCurveTo', 13, 14, 15, 16, 17, 18],
        ['closePath'],
    ])
})

test('copies share stable geometry identities until either path changes', () => {
    const source = new DrawPath()
    source.rect(1, 2, 3, 4)
    const commands = source.commands
    const clone = source.clone()
    const constructed = new DrawPath(source)
    assert.equal(clone.commands, commands)
    assert.equal(constructed.commands, commands)
    source.lineTo(10, 20)
    assert.notEqual(source.commands, commands)
    assert.equal(clone.commands, commands)
    assert.deepEqual(clone.commands, [['rect', 1, 2, 3, 4]])
    clone.lineTo(30, 40)
    assert.notEqual(clone.commands, commands)
    assert.equal(constructed.commands, commands)
    assert.deepEqual(source.commands.at(-1), ['lineTo', 10, 20])
    assert.deepEqual(clone.commands.at(-1), ['lineTo', 30, 40])
})

test('unshared appends preserve array identity and expose length/last-command invalidation', () => {
    const path = new DrawPath()
    const commands = path.commands
    path.moveTo(1, 2)
    const first = commands.at(-1)
    path.lineTo(3, 4)
    assert.equal(path.commands, commands)
    assert.equal(commands.length, 2)
    assert.notEqual(commands.at(-1), first)
})

test('addPath snapshots source geometry and the transform dictionary', () => {
    const source = new DrawPath()
    source.rect(0, 0, 10, 20)
    const commands = source.commands
    const matrix = { a: 2, b: 3, c: 4, d: 5, e: 6, f: 7 }
    const target = new DrawPath()
    target.addPath(source, matrix)
    matrix.e = 100
    source.lineTo(30, 40)
    const command = target.commands[0]
    assert.ok(command && command[0] === 'addPath')
    assert.equal(command[1].commands, commands)
    assert.deepEqual(command[1].commands, [['rect', 0, 0, 10, 20]])
    assert.deepEqual(command[2], [2, 4, 6, 3, 5, 7, 0, 0, 1])
})

test('self-addition takes a finite snapshot instead of a recursive path reference', () => {
    const path = new DrawPath()
    path.rect(0, 0, 10, 10)
    const commands = path.commands
    path.addPath(path, { e: 20 })
    const append = path.commands[1]
    assert.ok(append && append[0] === 'addPath')
    assert.equal(append[1].commands, commands)
    assert.equal(append[1].commands.length, 1)
    assert.notEqual(path.commands, commands)
})

test('transforms record only existing geometry and accept DOMMatrix aliases', () => {
    const path = new DrawPath()
    path.transform({ e: 10 })
    assert.deepEqual(path.commands, [])
    path.rect(1, 2, 3, 4)
    path.transform({})
    path.transform({ a: Infinity })
    assert.equal(path.commands.length, 1)
    const transform = { m11: 2, m12: 3, m21: 4, m22: 5, m41: 6, m42: 7 }
    path.transform(transform)
    transform.m41 = 100
    path.lineTo(8, 9)
    assert.deepEqual(path.commands, [
        ['rect', 1, 2, 3, 4],
        ['transform', [2, 4, 6, 3, 5, 7, 0, 0, 1]],
        ['lineTo', 8, 9],
    ])
})

test('roundRect snapshots iterable corner radii including independent ellipse axes', () => {
    const radius = { x: 3, y: 7 }
    const radii = [radius, 2]
    const path = new DrawPath()
    path.roundRect(1, 2, -30, 40, radii.values())
    radius.x = 50
    radii.push(100)
    assert.deepEqual(path.commands, [['roundRect', 1, 2, -30, 40, [{ x: 3, y: 7 }, 2]]])
})

test('arcs preserve zero radii, rotation, angles and direction for the tessellator', () => {
    const path = new DrawPath()
    path.arc(1, 2, 3, 4, 5, true)
    path.ellipse(6, 7, 0, 9, 10, 11, 12)
    path.arcTo(13, 14, 15, 16, 0)
    assert.deepEqual(path.commands, [
        ['ellipse', 1, 2, 3, 3, 0, 4, 5, true],
        ['ellipse', 6, 7, 0, 9, 10, 11, 12, false],
        ['arcTo', 13, 14, 15, 16, 0],
    ])
})

test('invalid inputs leave existing commands and shared snapshot identities unchanged', () => {
    const path = new DrawPath()
    path.moveTo(1, 2)
    const clone = path.clone()
    const commands = path.commands
    path.moveTo(NaN, 0)
    path.lineTo(0, Infinity)
    path.rect(0, 0, 10, Infinity)
    path.roundRect(0, 0, 10, 10, { x: 1, y: NaN })
    path.quadraticCurveTo(0, 0, 10, NaN)
    path.bezierCurveTo(0, 0, 10, 10, 20, Infinity)
    path.arc(0, 0, 10, 0, Infinity)
    path.arcTo(0, 0, 10, 10, NaN)
    path.addPath(clone, { e: Infinity })
    assert.throws(() => path.arc(0, 0, -1, 0, 1), { name: 'IndexSizeError' })
    assert.throws(() => path.ellipse(0, 0, 1, -1, 0, 0, 1), { name: 'IndexSizeError' })
    assert.throws(() => path.arcTo(0, 0, 1, 1, -1), { name: 'IndexSizeError' })
    assert.throws(() => path.roundRect(0, 0, 10, 10, -1), RangeError)
    assert.throws(() => path.roundRect(0, 0, 10, 10, []), RangeError)
    assert.throws(() => path.roundRect(0, 0, 10, 10, [1, 2, 3, 4, 5]), RangeError)
    assert.equal(path.commands, commands)
    assert.equal(clone.commands, commands)
    assert.deepEqual(commands, [['moveTo', 1, 2]])
})

test('dispose preserves retained commands and future mutations', () => {
    const path = new DrawPath()
    path.rect(1, 2, 3, 4)
    const commands = path.commands
    path.dispose()
    path.dispose()
    assert.equal(path.commands, commands)
    path.lineTo(5, 6)
    assert.deepEqual(path.commands, [
        ['rect', 1, 2, 3, 4],
        ['lineTo', 5, 6],
    ])
})
