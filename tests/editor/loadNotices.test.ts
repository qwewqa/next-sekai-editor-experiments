import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// Every kind of load event has a load notice (Part 1 §1.4.3). Both lists are read from source,
// since the notices need the app's bundler: an event added to `local/startup/events.ts` fails here
// until `loadNoticeOf` has its notice (the compiler checks the same).
const read = (path: string) => readFileSync(new URL(`../../src/${path}`, import.meta.url), 'utf8')

test('every load event kind has a load notice', () => {
    const events = read('local/startup/events.ts')
    const union = events.slice(
        events.indexOf('export type LoadEvent'),
        events.indexOf('/** This load'),
    )
    const kinds = [...union.matchAll(/kind: '(\w+)'/g)].map((match) => match[1]!)
    assert.ok(kinds.length >= 13)

    const notices = read('editor/loadNotices.ts')
    const table = notices.slice(notices.indexOf('export const loadNoticeOf'))
    const keyed = [...table.matchAll(/^ {4}(\w+): /gm)].map((match) => match[1]!)
    assert.deepEqual([...keyed].sort(), [...kinds].sort())
})

test('every load notice has a place in the table’s order', () => {
    const notices = read('editor/loadNotices.ts')
    const order = read('editor/loadOrder.ts')
    for (const [, name] of notices.matchAll(/LOAD_ORDER\.(\w+)/g))
        assert.ok(order.includes(`    ${name}: `), name)
})
