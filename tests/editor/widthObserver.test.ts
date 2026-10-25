import assert from 'node:assert/strict'
import test from 'node:test'

// The width observer reports a field's width, and a field fitted at that width needs no second fit.

type Entries = { target: object; contentRect: { width: number } }[]
let report: (entries: Entries) => void = () => undefined
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    constructor(callback: (entries: Entries) => void) {
        report = callback
    }
    observe() {}
    unobserve() {}
}
const { fittedAtWidth, observeWidth } = await import('../../src/modals/form/widthObserver')

const watched = () => {
    const element = {}
    let fits = 0
    observeWidth(element as Element, () => fits++)
    return { element, fits: () => fits }
}
const resize = (element: object, width: number) => {
    report([{ target: element, contentRect: { width } }])
}

test('the first entry fits a field that was not fitted at a width', () => {
    const field = watched()
    resize(field.element, 400)
    assert.equal(field.fits(), 1)
    resize(field.element, 400)
    assert.equal(field.fits(), 1)
    resize(field.element, 300)
    assert.equal(field.fits(), 2)
})

test('a field fitted at the width the entry reports is not fitted again, a later width fits it', () => {
    const field = watched()
    fittedAtWidth(field.element as Element, 400)
    resize(field.element, 400)
    assert.equal(field.fits(), 0)
    resize(field.element, 350.5)
    assert.equal(field.fits(), 1)
})

test('a field fitted while hidden fits when it first has a width', () => {
    const field = watched()
    fittedAtWidth(field.element as Element, NaN)
    resize(field.element, 400)
    assert.equal(field.fits(), 1)
})

test('a width recorded for an element that is not observed is ignored', () => {
    fittedAtWidth({} as Element, 400)
})
