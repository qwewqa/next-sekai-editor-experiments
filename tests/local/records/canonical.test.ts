import assert from 'node:assert/strict'
import test from 'node:test'
import { canonical, canonicalBytes, type RecordValue } from '../../../src/local/records/canonical'
import { toRecords } from '../../../src/local/records/records'
import { edgeChart, goldenChart, stateOf } from './charts'
import { samplePaths, sampleState } from './samples'
import { canonicalVectors } from './vectors'

test('the canonical encoder writes the hand-written vectors', () => {
    for (const [name, value, text] of canonicalVectors) assert.equal(canonical(value), text, name)
})

test('canonical bytes are UTF-8 of the canonical text, escapes included', () => {
    assert.deepEqual(
        [...canonicalBytes(['\u00e9', '\udc00'])],
        [...new TextEncoder().encode('["\u00e9","\\udc00"]')],
    )
})

test('the canonical encoder throws on anything a record cannot hold', () => {
    const bad: [string, unknown][] = [
        ['NaN', NaN],
        ['Infinity', Infinity],
        ['-Infinity', -Infinity],
        ['null', null],
        ['undefined', undefined],
        ['object', { a: 1 }],
        ['Map', new Map()],
        ['typed array', new Uint8Array(1)],
        ['toJSON', { toJSON: () => 1 }],
        ['bigint', 1n],
        // eslint-disable-next-line no-sparse-arrays
        ['hole', [1, , 2]],
        ['undefined item', [1, undefined]],
        ['nested null', [[null]]],
        ['array subclass', new (class extends Array {})()],
    ]
    for (const [name, value] of bad)
        assert.throws(() => canonical(value as RecordValue), TypeError, name)
})

test('an array with its own or an inherited toJSON is refused, not honoured', () => {
    const own = Object.assign([1], { toJSON: () => [2] })
    assert.throws(() => canonical(own), TypeError)
    const proto = Array.prototype as unknown as { toJSON?: () => unknown }
    proto.toJSON = () => 'polluted'
    try {
        assert.throws(() => canonical([1, [2]]), TypeError)
    } finally {
        delete proto.toJSON
    }
    assert.equal(canonical([1, [2]]), '[1,[2]]')
})

/** The canonical rule written out item by item, to check the encoder's `JSON.stringify` path. */
const byItems = (value: RecordValue): string =>
    Array.isArray(value)
        ? `[${(value as RecordValue[]).map(byItems).join(',')}]`
        : JSON.stringify(value)

test("the encoder's text equals the rule item by item on every record of the charts and samples", () => {
    const states = [stateOf(goldenChart()), stateOf(edgeChart()), ...samplePaths.map(sampleState)]
    for (const state of states) {
        const { header, kinds } = toRecords(state)
        for (const record of [
            header,
            ...kinds.flatMap(({ records }) => records.map((r) => r.record)),
        ])
            assert.equal(canonical(record), byItems(record))
    }
    for (const [name, value] of canonicalVectors)
        assert.equal(byItems(value), canonical(value), name)
})
