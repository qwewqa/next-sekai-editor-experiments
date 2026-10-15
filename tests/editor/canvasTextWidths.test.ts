import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { clearTextWidths, measureCachedText, measureText } from '../../src/editor/canvas/text'
import type { EditorDrawContext } from '../../src/editor/canvas/types'

beforeEach(clearTextWidths)

const fixture = () => {
    let calls = 0
    let fontGeneration = 1
    const stack: { font: string; fontKerning: string }[] = []
    const ctx = {
        font: 'unchanged',
        fontKerning: 'none',
        save() {
            stack.push({ font: this.font, fontKerning: this.fontKerning })
        },
        restore() {
            Object.assign(this, stack.pop())
        },
        measureText(text: string) {
            calls++
            return { width: text.length * parseFloat(this.font) * fontGeneration }
        },
    }
    const context = { ctx, scale: 30, fontFamily: 'sans-serif' } as unknown as EditorDrawContext
    return {
        context,
        ctx,
        calls: () => calls,
        nextFontGeneration: () => fontGeneration++,
    }
}

test('normal labels keep exact measurements, normalization, zero-width hits and caller state', () => {
    const { context, ctx, calls } = fixture()
    const labels = ['Group', '120', '0.5', '\t Group  name\n', '', '日本語', '👩‍🚀']
    for (const size of [0.4, 0.5]) {
        for (const text of labels) {
            const expected = measureText(context, text, size)
            assert.equal(measureCachedText(context, text, size), expected)
        }
    }
    const measured = calls()
    for (let frame = 0; frame < 100; frame++) {
        for (const size of [0.4, 0.5]) {
            for (const text of labels) measureCachedText(context, text, size)
        }
    }
    assert.equal(calls(), measured)
    assert.equal(ctx.font, 'unchanged')
    assert.equal(ctx.fontKerning, 'none')
})

test('six thousand distinct visible names stay cached across repeated whole-frame measurements', () => {
    const { context, calls } = fixture()
    const names = Array.from({ length: 6000 }, (_, i) => `Group ${String(i).padStart(4, '0')}`)
    for (let frame = 0; frame < 4; frame++) {
        names.forEach((text, i) => {
            const size = i % 2 ? 0.4 : 0.5
            assert.equal(measureCachedText(context, text, size), text.length * size)
        })
        assert.equal(calls(), names.length)
    }
})

test('entry cap is shared across arbitrary size maps and FIFO hits do not change admission order', () => {
    const { context, calls } = fixture()
    for (let size = 1; size <= 8192; size++) measureCachedText(context, 'X', size)
    assert.equal(calls(), 8192)
    measureCachedText(context, 'X', 1)
    assert.equal(calls(), 8192)
    measureCachedText(context, 'X', 8193)
    for (let size = 2; size <= 8193; size++) measureCachedText(context, 'X', size)
    assert.equal(calls(), 8193)
    measureCachedText(context, 'X', 1)
    assert.equal(calls(), 8194, 'oldest entry is evicted even after a cache hit')
})

test('rename churn obeys the shared UTF16-unit cap before reaching the entry cap', () => {
    const { context, calls } = fixture()
    const names = Array.from(
        { length: 10000 },
        (_, i) => `Rename audit ${String(i).padStart(4, '0')} ${'X'.repeat(64)}`,
    )
    assert.equal(names[0]?.length, 82)
    names.forEach((text, i) => measureCachedText(context, text, i % 2 ? 0.4 : 0.5))
    const retained = Math.floor((256 * 1024) / 82)
    assert.equal(retained, 3196)
    for (let i = names.length - retained; i < names.length; i++) {
        measureCachedText(context, names[i]!, i % 2 ? 0.4 : 0.5)
    }
    assert.equal(calls(), names.length, 'all 3196 newest names hit, accounting for 262072 units')
    const evicted = names.length - retained - 1
    measureCachedText(context, names[evicted]!, evicted % 2 ? 0.4 : 0.5)
    assert.equal(calls(), names.length + 1)
})

test('oversized strings are measured uncached without evicting ordinary names', () => {
    const { context, calls } = fixture()
    measureCachedText(context, 'kept')
    const oversized = 'X'.repeat(256 * 1024 + 1)
    const expected = oversized.length * 0.4
    assert.equal(measureCachedText(context, oversized), expected)
    assert.equal(measureCachedText(context, oversized), expected)
    assert.equal(calls(), 3)
    measureCachedText(context, 'kept')
    assert.equal(calls(), 3)
})

test('an exactly fitting string is cached and empty keys remain bounded by entry count', () => {
    const { context, calls } = fixture()
    const exact = 'X'.repeat(256 * 1024)
    measureCachedText(context, exact)
    measureCachedText(context, exact)
    assert.equal(calls(), 1)
    clearTextWidths()
    for (let size = 1; size <= 10000; size++) measureCachedText(context, '', size)
    for (let size = 1809; size <= 10000; size++) measureCachedText(context, '', size)
    assert.equal(calls(), 10001)
    measureCachedText(context, '', 1808)
    assert.equal(calls(), 10002)
})

test('font invalidation and the existing four font/zoom buckets still invalidate correctly', () => {
    const { context, calls, nextFontGeneration } = fixture()
    const before = measureCachedText(context, 'name')
    nextFontGeneration()
    assert.equal(measureCachedText(context, 'name'), before)
    clearTextWidths()
    assert.equal(measureCachedText(context, 'name'), before * 2)
    assert.equal(calls(), 2)
    for (let scale = 31; scale <= 33; scale++) measureCachedText({ ...context, scale }, 'name')
    assert.equal(calls(), 5)
    measureCachedText(context, 'name')
    assert.equal(calls(), 5)
    measureCachedText({ ...context, fontFamily: 'serif' }, 'name')
    measureCachedText(context, 'name')
    assert.equal(calls(), 6, 'recent original bucket remains cached')
    measureCachedText({ ...context, scale: 31 }, 'name')
    assert.equal(calls(), 7, 'oldest font/zoom bucket was removed')
})
