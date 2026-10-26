import assert from 'node:assert/strict'
import test from 'node:test'
import { inlineName } from '../../src/utils/inlineName'

const SHALOM = '\u05E9\u05DC\u05D5\u05DD'

test('an ordinary name is unchanged', () => {
    for (const name of ['coconut.nxsp', 'Coconut (Master)', 'メルト', 'Café – 譜面'])
        assert.equal(inlineName(name), name)
})

test('line breaks and other control characters become one space', () => {
    assert.equal(inlineName('a\nb\r\nc\t\u0000d\u2028e\u0085f'), 'a b c d e f')
})

test('a name with right-to-left text is isolated, and its overrides are dropped', () => {
    assert.equal(inlineName(`Melt\u202E${SHALOM}\nB`), `\u2068Melt${SHALOM} B\u2069`)
})

test('isolates already in the name cannot end the isolate early', () => {
    assert.equal(
        inlineName('\u05D0\u2069 Choose Replace \u2068'),
        '\u2068\u05D0 Choose Replace \u2069',
    )
})

test('an override with no right-to-left text needs no isolate', () => {
    assert.equal(inlineName('a\u202Eb'), 'ab')
})

test('a name already isolated is the same', () => {
    const once = inlineName('\u05D0b')
    assert.equal(inlineName(once), once)
})
