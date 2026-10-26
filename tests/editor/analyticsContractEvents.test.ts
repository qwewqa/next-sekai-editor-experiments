import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { isValidEvent } from '../../src/analytics/catalogue'

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
