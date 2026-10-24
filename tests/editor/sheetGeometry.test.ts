import assert from 'node:assert/strict'
import test from 'node:test'
import {
    getSheetGeometry,
    historySheetFits,
    prospectivePeekClearance,
} from '../../src/editor/sheetGeometry'

test('the History candidate uses the same right-sheet top and bottom insets', () => {
    assert.deepEqual(getSheetGeometry({ width: 520, height: 212, peekClearance: 120 }), {
        side: 'right',
        width: 322.4,
        height: 76,
        top: 128,
    })
})

test('a short pane takes the right sheet only from 31rem wide', () => {
    // Under a phone's top dock (360 × 640, 375 × 667) and beside a 667 × 375 phone's side dock.
    for (const [width, height] of [
        [360, 312],
        [375, 339],
        [371, 343],
        [495, 343],
    ] as const)
        assert.equal(getSheetGeometry({ width, height, peekClearance: 112 }).side, 'bottom')
    // Beside an 844 × 390 phone's side dock, and a 1280 × 480 window.
    for (const [width, height] of [
        [496, 343],
        [548, 358],
        [600, 448],
    ] as const)
        assert.equal(getSheetGeometry({ width, height, peekClearance: 112 }).side, 'right')
    assert.equal(
        getSheetGeometry({ width: 548, height: 358, peekClearance: 112, rem: 20 }).side,
        'bottom',
    )
})

test('a History sheet needs 116 pixels after its actual chrome', () => {
    const input = { width: 667, height: 288, peekClearance: prospectivePeekClearance(667)! }
    assert.equal(historySheetFits(input, 65), false)
    assert.equal(historySheetFits(input, 64), true)
    assert.equal(historySheetFits(input, 64 + 40), false)
})

test('short bottom sheets include their CSS minimum, and taller sheets use rem limits', () => {
    const short = getSheetGeometry({ width: 320, height: 360, peekClearance: 120 })
    assert.equal(short.side, 'bottom')
    assert.equal(short.height, 144)
    assert.equal(getSheetGeometry({ width: 320, height: 436, peekClearance: 120 }).height, 188)
    assert.equal(getSheetGeometry({ width: 320, height: 1000, peekClearance: 120 }).height, 480)
    assert.equal(
        getSheetGeometry({ width: 320, height: 1000, peekClearance: 120, rem: 20 }).height,
        550,
    )
})

test('prospective peek geometry includes top padding and retains measured wrapping', () => {
    assert.equal(prospectivePeekClearance(520), 112)
    assert.equal(prospectivePeekClearance(667), 92)
    assert.equal(prospectivePeekClearance(280), undefined)
    assert.equal(prospectivePeekClearance(280, 160), 160)
    assert.equal(prospectivePeekClearance(520, 140), 140)
    assert.equal(prospectivePeekClearance(520, 0, 20), 140)
    assert.equal(prospectivePeekClearance(520, 0, 16, 8), 92)
})
