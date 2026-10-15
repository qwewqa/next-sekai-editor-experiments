import assert from 'node:assert/strict'
import test from 'node:test'
import { NameLayout, type NamePlacement } from '../../src/editor/canvas/nameLayout'

const name = (
    x: number,
    y: number,
    highlighted = false,
    owner = {},
    key = 'stage',
): NamePlacement => ({
    owner,
    key,
    highlighted,
    box: { l: x, r: x + 1, t: y, b: y + 0.4 },
})

test('uncrowded names all remain, including boxes sharing spatial bins and touching edges', () => {
    const names = [name(0, 0), name(1, 0), name(0, 0.4), name(1, 0.4), name(-1, -0.4)]
    const layout = new NameLayout()
    assert.deepEqual([...layout.place(names)], names)
})

test('all highlighted names reserve space before ordinary names, even if they overlap', () => {
    const names = [name(0, 0), name(0.1, 0.1, true), name(0.2, 0.2, true), name(2, 0)]
    const visible = new NameLayout().place(names)
    assert.deepEqual(
        names.filter((name) => visible.has(name)),
        names.slice(1),
    )
})

test('ordinary names never overlap one another, including across negative bin boundaries', () => {
    const names = Array.from({ length: 150 }, (_, i) =>
        name((i % 10) / 2 - 2, Math.floor(i / 10) / 5 - 1),
    )
    const visible = [...new NameLayout().place(names)]
    assert.ok(visible.length > 10)
    assert.ok(visible.length < names.length)
    for (let a = 0; a < visible.length; a++) {
        for (let b = a + 1; b < visible.length; b++) {
            const first = visible[a]!.box,
                second = visible[b]!.box
            assert.ok(
                first.l >= second.r ||
                    second.l >= first.r ||
                    first.t >= second.b ||
                    second.t >= first.b,
            )
        }
    }
})

test('new labels entering an edge do not cascade through retained labels while panning', () => {
    const layout = new NameLayout()
    const names = Array.from({ length: 100 }, (_, i) => name(0, i * 0.3))
    const first = layout.place(names.slice(2, 90))
    // Requests are reconstructed every frame; entity and label role survive.
    const secondNames = names.slice(1, 89).map((name) => ({ ...name, box: { ...name.box } }))
    const second = layout.place(secondNames)
    for (const name of secondNames) {
        const original = names.find((old) => old.owner === name.owner)!
        if (first.has(original)) assert.ok(second.has(name))
    }
})

test('hovering reveals a suppressed label immediately and reserves its space', () => {
    const layout = new NameLayout()
    const first = name(0, 0),
        second = name(0, 0)
    assert.deepEqual([...layout.place([first, second])], [first])
    const hovered = { ...second, highlighted: true }
    assert.deepEqual([...layout.place([first, hovered])], [hovered])
})

test('zooming apart restores every name; previous suppression is never retained', () => {
    const layout = new NameLayout()
    const names = Array.from({ length: 10 }, (_, i) => name(0, i * 0.05))
    assert.ok(layout.place(names).size < names.length)
    const zoomed = names.map((name, i) => ({ ...name, box: { ...name.box, t: i, b: i + 0.4 } }))
    assert.equal(layout.place(zoomed).size, names.length)
})

test('an owner can retain different stage and group labels; clipped placement is not its identity', () => {
    const layout = new NameLayout()
    const owner = {}
    const stage = name(0, 0, false, owner, 'stage')
    const group = name(1, 0, false, owner, 'group')
    assert.equal(layout.place([stage, group]).size, 2)
    const clipped = { ...stage, box: { ...stage.box, l: 0.2 } }
    const incoming = name(0, 0)
    assert.deepEqual([...layout.place([incoming, clipped, group])], [clipped, group])
})

test('an empty frame drops old identities and independent contexts do not share choices', () => {
    const a = name(0, 0),
        b = name(0, 0)
    const layout = new NameLayout()
    assert.deepEqual([...layout.place([a, b])], [a])
    assert.deepEqual([...new NameLayout().place([b, a])], [b])
    layout.place([])
    assert.deepEqual([...layout.place([b, a])], [b])
})
