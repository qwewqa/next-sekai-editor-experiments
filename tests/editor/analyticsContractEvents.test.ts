import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { catalogue, isValidEvent } from '../../src/analytics/catalogue'

// infra/stats/scripts/contract-test.sh sends these events to a real Umami. They must be events the
// client would send, or the server test passes on data no browser produces.
const events = JSON.parse(
    readFileSync(
        new URL('../../infra/stats/scripts/contract-events.json', import.meta.url),
        'utf8',
    ),
) as { name: string; data: Record<string, unknown> }[]

test('the stats contract test sends only events the catalogue accepts', () => {
    const commands = new Set(['zoomXIn', 'undo'])
    for (const { name, data } of events) {
        if (name === '') continue
        assert.ok(isValidEvent(name, data, commands), `${name} ${JSON.stringify(data)}`)
    }
})

// The monthly totals take percentiles of the millisecond properties and sums of the other numbers
// (infra/stats/host/retention.sql). Its list must be the catalogue's.
test('the monthly totals treat the catalogue’s millisecond properties as timings', () => {
    const sql = readFileSync(
        new URL('../../infra/stats/host/retention.sql', import.meta.url),
        'utf8',
    )
    const timings = new Set(
        Object.values(catalogue).flatMap((props) =>
            Object.entries(props)
                .filter(([, prop]) => prop === 'ms')
                .map(([key]) => key),
        ),
    )
    const listed = [...sql.matchAll(/data_key (?:NOT )?IN \(([^)]*)\)/g)].map((match) =>
        [...match[1]!.matchAll(/'([^']+)'/g)].map((name) => name[1]!).sort(),
    )
    assert.equal(listed.length, 2)
    for (const keys of listed) assert.deepEqual(keys, [...timings].sort())
})
