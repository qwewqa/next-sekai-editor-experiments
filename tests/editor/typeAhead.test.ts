import assert from 'node:assert/strict'
import test from 'node:test'
import { createTypeAhead, isTypeAheadKey } from '../../src/utils/typeAhead'

// What a Turkish system does to a lowercasing call that names no language.
const onTurkishSystem = (run: () => void) => {
    const original = String.prototype.toLocaleLowerCase
    String.prototype.toLocaleLowerCase = function (this: string, locales?: string | string[]) {
        return original.call(this, locales ?? 'tr')
    }
    try {
        run()
    } finally {
        String.prototype.toLocaleLowerCase = original
    }
}

const labels = ['Group', 'Size', 'SFX', 'Stage', 'Speed', 'Note Type', '2nd Ease']

test('a letter moves to the next label starting with it, wrapping', () => {
    const typeAhead = createTypeAhead(() => 'en')
    assert.equal(typeAhead('s', labels, 0, 0), 1)
    assert.equal(typeAhead('n', labels, 1, 1000), 5)
    assert.equal(typeAhead('G', labels, 5, 2000), 0)
    assert.equal(typeAhead('2', labels, 0, 3000), 6)
    // Nothing focused yet starts from the top.
    assert.equal(typeAhead('s', labels, -1, 4000), 1)
})

test('one letter repeated cycles through its matches', () => {
    const typeAhead = createTypeAhead(() => 'en')
    assert.deepEqual(
        [0, 100, 200, 300, 400].map((now, step) =>
            typeAhead('s', labels, [0, 1, 2, 3, 4][step]!, now),
        ),
        [1, 2, 3, 4, 1],
    )
})

test('letters typed close together build a prefix', () => {
    const typeAhead = createTypeAhead(() => 'en')
    assert.equal(typeAhead('s', labels, 0, 0), 1)
    // "st" keeps searching from the current item.
    assert.equal(typeAhead('t', labels, 1, 200), 3)
    assert.equal(typeAhead('a', labels, 3, 400), 3)
    // After a pause a letter starts afresh.
    assert.equal(typeAhead('s', labels, 3, 1000), 4)
})

test('a prefix without a match leaves the choice', () => {
    const typeAhead = createTypeAhead(() => 'en')
    assert.equal(typeAhead('x', labels, 0, 0), undefined)
    assert.equal(typeAhead('s', [], -1, 1000), undefined)
})

test('the editor language, not the system language, decides the case', () => {
    onTurkishSystem(() => {
        const labels = ['Alpha', 'Intro', 'Işık']
        assert.equal(createTypeAhead(() => 'en')('i', labels, 0, 0), 1)
        assert.equal(createTypeAhead(() => 'en')('I', labels, 0, 0), 1)
        // Turkish keeps its two letters: "i" and "İ" are one, "ı" and "I" the other.
        const turkish = ['Alpha', 'İz', 'Işık']
        assert.equal(createTypeAhead(() => 'tr')('i', turkish, 0, 0), 1)
        assert.equal(createTypeAhead(() => 'tr')('I', turkish, 0, 0), 2)
        assert.equal(createTypeAhead(() => 'tr')('ı', turkish, 0, 0), 2)
    })
})

test('only plain letters and digits type ahead', () => {
    const key = (key: string, modifiers: Partial<KeyboardEvent> = {}) =>
        isTypeAheadKey({ key, ctrlKey: false, altKey: false, metaKey: false, ...modifiers })
    assert.equal(key('a'), true)
    assert.equal(key('É'), true)
    assert.equal(key('7'), true)
    assert.equal(key('ア'), true)
    assert.equal(key(' '), false)
    assert.equal(key('.'), false)
    assert.equal(key('ArrowDown'), false)
    assert.equal(key('a', { ctrlKey: true }), false)
    assert.equal(key('a', { altKey: true }), false)
    assert.equal(key('a', { metaKey: true }), false)
})
