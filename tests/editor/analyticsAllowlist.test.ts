import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { allowlistRows, allowlistSql, commandNamesFrom } from '../../src/analytics/allowlist'
import { catalogue, isValidEvent } from '../../src/analytics/catalogue'

// The server's monthly totals take only what the catalogue allows (infra/stats/host/allowlist.sql).
// The file is generated; this keeps it in step, as the privacy test keeps the page.

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const names = commandNamesFrom(read('src/editor/commands/index.ts'))

test('allowlist.sql is what the catalogue and the built-in commands generate', () => {
    assert.equal(
        read('infra/stats/host/allowlist.sql'),
        allowlistSql(names),
        'run npm run analytics:allowlist',
    )
})

test('the built-in command names are found', () => {
    for (const name of ['open', 'undo', 'zoomXIn', 'laneDivisionCustom', 'openContextMenu'])
        assert.ok(names.includes(name), name)
    assert.ok(names.length > 100)
    assert.ok(names.every((name) => /^[a-zA-Z][a-zA-Z0-9]*$/.test(name)))
})

test('the allowlist has every property of the catalogue, and its timings are the millisecond ones', () => {
    const rows = allowlistRows(names)
    for (const [event, props] of Object.entries(catalogue))
        for (const property of Object.keys(props))
            assert.ok(
                rows.some((row) => row[0] === event && row[1] === property),
                `${event}.${property}`,
            )
    const timings = new Set(
        Object.entries(catalogue).flatMap(([event, props]) =>
            Object.entries(props)
                .filter(([, prop]) => prop === 'ms')
                .map(([property]) => `${event}.${property}`),
        ),
    )
    const listed = new Set(
        rows.filter((row) => row[2] === 'time').map((row) => `${row[0]}.${row[1]}`),
    )
    assert.deepEqual([...listed].sort(), [...timings].sort())
})

test('a value the catalogue rejects is not in the allowlist', () => {
    const rows = allowlistRows(names)
    assert.equal(isValidEvent('save', { outcome: 'person@example.com' }), false)
    assert.ok(!rows.some((row) => row[3] === 'person@example.com'))
    assert.ok(rows.some((row) => row[0] === 'save' && row[1] === 'outcome' && row[3] === 'done'))
})
