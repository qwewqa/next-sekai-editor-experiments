import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { bucket, catalogue, isValidEvent, MAX_KEYS, scales } from '../../src/analytics/catalogue'
import { operationCodecs } from '../../src/history/operations/registry'

test('each range starts at its limit and ends just below the next', () => {
    const edges: [Parameters<typeof bucket>[0], number, string][] = [
        ['time', 0, '<50'],
        ['time', 49.9, '<50'],
        ['time', 50, '50-100'],
        ['time', 29_999, '10k-30k'],
        ['time', 30_000, '30k+'],
        ['size', 16 * 1024 - 1, '<16K'],
        ['size', 16 * 1024, '16K-64K'],
        ['size', 64 * 1024 ** 2, '64M+'],
        ['objects', 0, '0'],
        ['objects', 1, '1-9'],
        ['objects', 9, '1-9'],
        ['objects', 10, '10-99'],
        ['objects', 9_999, '5k-10k'],
        ['objects', 10_000, '10k-20k'],
        ['objects', 20_000, '20k+'],
        ['small', 0, '0'],
        ['small', 1, '1'],
        ['small', 5, '2-5'],
        ['small', 100, '21-100'],
        ['small', 101, '101+'],
        ['duration', 0, '0'],
        ['duration', 1, '<1m'],
        ['duration', 60_000, '1m-5m'],
        ['frame', 50, '50-100'],
        ['frame', 500, '500+'],
        ['viewport', 639, 's'],
        ['viewport', 640, 'm'],
        ['viewport', 1440, 'xl'],
        ['dpr', 1, '1'],
        ['dpr', 1.25, '<2'],
        ['dpr', 2, '<3'],
        ['dpr', 3, '3+'],
        ['cores', 2, '1-2'],
        ['cores', 16, '9+'],
        ['noteSpeed', 7.9, '<8'],
        ['noteSpeed', 9.5, '8-10'],
        ['noteSpeed', 10, '10'],
        ['noteSpeed', 12, '10-12'],
    ]
    for (const [scale, value, label] of edges)
        assert.equal(bucket(scale, value), label, `${scale} ${value}`)
    for (const [name, labels] of Object.entries(scales))
        assert.equal(new Set(labels).size, labels.length, name)
})

test('an event passes only with known properties, each in its set', () => {
    assert.ok(isValidEvent('visit', { site: 'test', standalone: false, viewport: 'xl' }))
    assert.ok(isValidEvent('visit', { version: '0.6.0', browserLanguage: 'other' }))
    assert.ok(!isValidEvent('visits', {}), 'an unknown event')
    assert.ok(!isValidEvent('visit', { title: 'Coconut' }), 'an unknown property')
    assert.ok(!isValidEvent('visit', { site: 'elsewhere' }), 'a value outside the set')
    assert.ok(!isValidEvent('visit', { standalone: 'false' }), 'a string for a boolean')
    assert.ok(!isValidEvent('visit', { viewport: 1600 }), 'a number for a range')
    assert.ok(!isValidEvent('visit', { version: '0.6.0+abcd1234' }), 'a version past a tag')
    assert.ok(!isValidEvent('visit', { browserLanguage: 'en-US' }), 'a full language tag')
    assert.ok(!isValidEvent('toString', {}), 'a name from the prototype')
    assert.ok(!isValidEvent('notices', { constructor: 1 }), 'a key from the prototype')
    // Counts are whole, and capped.
    assert.ok(isValidEvent('notices', { error: 9999 }))
    assert.ok(!isValidEvent('notices', { error: 10_000 }))
    assert.ok(!isValidEvent('notices', { error: 1.5 }))
    assert.ok(!isValidEvent('notices', { error: -1 }))
})

test('usage takes the given command names from the sources that count', () => {
    const names = new Set(['save', 'zoomXIn'])
    assert.ok(isValidEvent('usage', { 'save.key': 2, 'zoomXIn.wheel': 1 }, names))
    assert.ok(!isValidEvent('usage', { 'save.key': 2 }), 'no names given')
    assert.ok(!isValidEvent('usage', { 'open.key': 1 }, names), 'a name not given')
    assert.ok(!isValidEvent('usage', { 'save.nested': 1 }, names), 'a source never counted')
    assert.ok(!isValidEvent('usage', { save: 1 }, names), 'no source')
})

test('edits takes every History operation, without its prefix', () => {
    const keys = Object.keys(operationCodecs).map((id) => id.replace(/^nse\./, ''))
    assert.ok(keys.length > 30)
    assert.ok(isValidEvent('edits', Object.fromEntries(keys.slice(0, MAX_KEYS).map((k) => [k, 1]))))
    for (const key of [...keys, 'undo', 'redo']) assert.ok(isValidEvent('edits', { [key]: 1 }), key)
    assert.ok(!isValidEvent('edits', { 'nse.note.add': 1 }))
})

test('an event has at most MAX_KEYS properties', () => {
    const names = Array.from({ length: MAX_KEYS + 1 }, (_, i) => `command${i}`)
    const usage = (count: number) =>
        Object.fromEntries(names.slice(0, count).map((name) => [`${name}.key`, 1]))
    assert.ok(isValidEvent('usage', usage(MAX_KEYS), new Set(names)))
    assert.ok(!isValidEvent('usage', usage(MAX_KEYS + 1), new Set(names)))
})

test('event names and property keys fit Umami', () => {
    for (const [name, props] of Object.entries(catalogue)) {
        assert.ok(name.length <= 50 && !/^[=+\-@\t\r]/.test(name), name)
        for (const key of Object.keys(props)) assert.ok(key.length <= 500, key)
        // A summary that splits keeps each part under Umami's documented 50 properties.
        assert.ok(MAX_KEYS <= 50)
    }
})

test('docs/analytics.md lists the catalogue', () => {
    const doc = readFileSync(new URL('../../docs/analytics.md', import.meta.url), 'utf8')
    const section = doc.slice(doc.indexOf('## The catalogue'), doc.indexOf('## Adding'))
    const rows = new Map<string, RegExp[]>()
    for (const [, name = '', props = ''] of section.matchAll(/^\| `(\w+)` \| [^|]+ \| (.+) \|$/gm))
        rows.set(
            name,
            [...props.matchAll(/`([^`]+)`/g)].map(
                ([, prop = '']) =>
                    new RegExp(
                        `^${prop.replace(/[.]/g, '\\.').replace(/<[^>]+>/g, '[^.]+(?:\\.[^.]+)?')}$`,
                    ),
            ),
        )
    assert.deepEqual([...rows.keys()].sort(), [...Object.keys(catalogue), 'usage'].sort())
    for (const [name, props] of Object.entries(catalogue)) {
        const patterns = rows.get(name) ?? []
        for (const key of Object.keys(props))
            assert.ok(
                patterns.some((pattern) => pattern.test(key)),
                `${name}.${key} is not in docs/analytics.md`,
            )
        for (const pattern of patterns)
            assert.ok(
                Object.keys(props).some((key) => pattern.test(key)),
                `docs/analytics.md lists ${name} ${String(pattern)}, which the catalogue lacks`,
            )
    }
})
