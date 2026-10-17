import assert from 'node:assert/strict'
import test from 'node:test'
import { canonical, canonicalBytes, type RecordValue } from '../../../src/local/records/canonical'
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
