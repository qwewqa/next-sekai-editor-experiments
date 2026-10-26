import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
    bucket,
    capCount,
    capMs,
    capSeconds,
    catalogue,
    fromRaw,
    isValidEvent,
    MAX_KEYS,
    measured,
    scales,
} from '../../src/analytics/catalogue'
import { operationCodecs } from '../../src/history/operations/registry'

const K = 1024

test('each range starts at its limit and ends just below the next', () => {
    const edges: [Parameters<typeof bucket>[0], number, string][] = [
        ['counts', 0, '0'],
        ['counts', 9, '9'],
        ['counts', 10, '10-12'],
        ['counts', 12, '10-12'],
        ['counts', 13, '13-15'],
        ['counts', 99, '80-99'],
        ['counts', 100, '100-129'],
        ['counts', 319, '250-319'],
        ['counts', 320, '320-399'],
        ['counts', 99_999, '80000-99999'],
        ['counts', 100_000, '100000+'],
        ['counts', 5_000_000, '100000+'],
        ['audio', 9_999, '<10'],
        ['audio', 10_000, '10-13'],
        ['audio', 199_999, '160-200'],
        ['audio', 1_199_999, '1000-1200'],
        ['audio', 1_200_000, '1200+'],
        ['size', 16 * K - 1, '<16K'],
        ['size', 16 * K, '16K-32K'],
        ['size', 512 * K, '512K-1M'],
        ['size', 1024 * K, '1M-2M'],
        ['size', 1024 ** 3 - 1, '512M-1G'],
        ['size', 16 * 1024 ** 3 - 1, '8G-16G'],
        ['size', 16 * 1024 ** 3, '16G+'],
        ['quota', 100, '<256M'],
        ['quota', 256 * K * K, '256M-1G'],
        ['quota', 256 * 1024 ** 3, '256G+'],
        ['usageShare', 49.9, '<50'],
        ['usageShare', 50, '50-70'],
        ['usageShare', 70, '70-80'],
        ['usageShare', 80, '70-80'],
        ['usageShare', 80.01, '80-90'],
        ['usageShare', 95, '95-100'],
        ['usageShare', 100, '100+'],
        ['viewport', 100, '<360'],
        ['viewport', 360, '360-400'],
        ['viewport', 1439.5, '1100-1440'],
        ['viewport', 2560, '2560+'],
        ['dpr', 0.75, '<1'],
        ['dpr', 1, '1'],
        ['dpr', 1.25, '1-1.5'],
        ['dpr', 1.5, '1.5-2'],
        ['dpr', 2, '2'],
        ['dpr', 2.25, '2-2.5'],
        ['dpr', 2.625, '2.5-3'],
        ['dpr', 3, '3'],
        ['dpr', 3.5, '3+'],
        ['noteSpeed', 1, '1-5'],
        ['noteSpeed', 9.9, '9-10'],
        ['noteSpeed', 10, '10'],
        ['noteSpeed', 10.1, '10-10.5'],
        ['noteSpeed', 10.5, '10.5-11'],
        ['noteSpeed', 11.5, '11.5-12'],
        ['noteSpeed', 12, '11.5-12'],
        ['peek', 24.9, '<25'],
        ['peek', 25, '25-50'],
        ['peek', 150, '150-200'],
        ['peek', 29_999, '10k-30k'],
        ['peek', 30_000, '30k+'],
        ['frame', 50, '50-100'],
        ['frame', 999, '500-1000'],
        ['frame', 2000, '2000+'],
        ['slowEvent', 104, '104-200'],
        ['slowEvent', 200, '200-500'],
        ['slowEvent', 1000, '1000+'],
        ['cores', 1, '1'],
        ['cores', 32, '32'],
        ['cores', 33, '33-48'],
        ['cores', 64, '49-64'],
        ['cores', 128, '97-128'],
        ['cores', 129, '129+'],
    ]
    for (const [scale, value, label] of edges)
        assert.equal(bucket(scale, value), label, `${scale} ${value}`)
    for (const [name, labels] of Object.entries(scales))
        assert.equal(new Set(labels).size, labels.length, name)
})

test('the scales have the ranges the spec lists', () => {
    assert.equal(scales.counts.length, 10 + 40 + 1)
    assert.equal(scales.audio.length, 1 + 21 + 1)
    assert.equal(scales.size.length, 1 + 20 + 1)
    assert.equal(scales.peek.length, 13)
    assert.equal(scales.cores.length, 32 + 5)
    assert.equal(scales.counts.at(-2), '80000-99999')
})

test('a measurement that is missing or not a number has no range', () => {
    assert.equal(measured('size', undefined), undefined)
    assert.equal(measured('size', Number.NaN), undefined)
    assert.equal(measured('size', Number.POSITIVE_INFINITY), undefined)
    assert.equal(measured('size', -1), undefined)
    assert.equal(measured('size', 0), '<16K')
    const sent = fromRaw('save', { size: Number.NaN, took: Number.NaN, buildMs: 12.4 })
    assert.deepEqual(sent, { buildMs: 12 })
})

test('action times are whole milliseconds, capped at ten minutes', () => {
    assert.equal(capMs(12.5), 13)
    assert.equal(capMs(-4), 0)
    assert.equal(capMs(600_000), 600_000)
    assert.equal(capMs(900_000), 600_000)
    const sent = fromRaw('open', { took: 1234.56, size: 20 * K })
    assert.deepEqual(sent, { took: 1235, size: '16K-32K' })
    assert.ok(isValidEvent('open', sent))
    for (const value of [600_001, 1.5, -1, '1k-2k'])
        assert.ok(!isValidEvent('open', { took: value }), String(value))
    assert.ok(isValidEvent('startup', { ready: 600_000 }))
})

test('the Undo window and the Recent Sessions count are exact', () => {
    assert.ok(isValidEvent('chart', { historySteps: 0 }))
    assert.ok(isValidEvent('chart', { historySteps: 1000 }))
    assert.ok(!isValidEvent('chart', { historySteps: 1001 }))
    assert.ok(!isValidEvent('chart', { historySteps: 1.5 }))
    assert.ok(isValidEvent('storage', { sessions: 9999 }))
    assert.ok(!isValidEvent('storage', { sessions: 10_000 }))
})

test('perf and peek stay within their key budgets', () => {
    // 45 is the most an event may carry; the figures here are the most each is built to populate.
    assert.equal(Object.keys(catalogue.perf).length, 37)
    assert.equal(Object.keys(catalogue.peek).length, 20)
    assert.ok(Object.keys(catalogue.perf).length <= MAX_KEYS)
    const every = (name: 'perf' | 'peek') =>
        Object.fromEntries(
            Object.entries(catalogue[name]).map(([key, prop]) => [
                key,
                typeof prop === 'string'
                    ? prop === 'boolean'
                        ? true
                        : 1
                    : 'oneOf' in prop
                      ? prop.oneOf[0]
                      : 'scale' in prop
                        ? scales[prop.scale][0]
                        : 1,
            ]),
        )
    assert.ok(isValidEvent('perf', every('perf')))
    assert.ok(isValidEvent('peek', every('peek')))
})

test('an event passes only with known properties, each in its set', () => {
    assert.ok(isValidEvent('visit', { site: 'test', standalone: false, viewport: '2560+' }))
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

test('a measured count is capped so a long visit keeps its perf event', () => {
    assert.equal(capCount(10_000), 9999)
    assert.equal(capCount(-3), 0)
    assert.ok(isValidEvent('perf', { interactions: capCount(25_000), cores: '33-48' }))
    assert.ok(!isValidEvent('perf', { interactions: 10_000 }))
})

test('playing and visible time are whole seconds, rounded and capped at a day', () => {
    assert.equal(capSeconds(0), 0)
    assert.equal(capSeconds(499), 0)
    assert.equal(capSeconds(500), 1)
    assert.equal(capSeconds(119_400), 119)
    assert.equal(capSeconds(86_400_000), 86_400)
    assert.equal(capSeconds(90_000_000), 86_400)
    assert.equal(capSeconds(-5), 0)
    assert.ok(isValidEvent('perf', { playSeconds: capSeconds(120_000), visibleTime: 86_400 }))
    for (const value of [86_401, 1.5, -1, '1m-5m', '0'])
        assert.ok(!isValidEvent('perf', { playSeconds: value }), String(value))
    assert.ok(!isValidEvent('perf', { visibleTime: '5m-20m' }))
})
