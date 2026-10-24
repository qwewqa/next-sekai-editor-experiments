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

// A load notice's severity picks its card glyph (colour system §5.6): warning where work is at risk
// or was affected, info where nothing is, and none for a confirmation or a route back.
const SEVERITY: Record<string, string | undefined> = {
    continued: undefined,
    storageCleared: 'warning',
    journalKept: 'warning',
    unsavedRecovered: 'info',
    unsavedInLocalData: 'warning',
    migrationFailed: 'warning',
    // Both forms: "Continued … from the old auto save" and "Kept … as a separate session".
    migrated: undefined,
    migratedRevision: 'warning',
    journalRecovered: undefined,
    journalLater: 'warning',
    journalFailed: 'warning',
    journalsFull: 'warning',
    storageNearlyFull: 'warning',
    notOpened: 'warning',
    openElsewhere: 'info',
    deletedElsewhere: 'warning',
    separateCopy: 'info',
    bgmNotLoaded: 'info',
}

test('every load notice kind has the severity the colour system gives it', () => {
    const notices = read('editor/loadNotices.ts')
    const table = notices.slice(notices.indexOf('export const loadNoticeOf'))
    const starts = [...table.matchAll(/^ {4}(\w+): /gm)]
    assert.deepEqual(starts.map((match) => match[1]).sort(), Object.keys(SEVERITY).sort())
    const found: Record<string, string | undefined> = {}
    starts.forEach((match, i) => {
        const body = table.slice(match.index, starts[i + 1]?.index ?? table.indexOf('\n}\n'))
        found[match[1]!] = /severity: '(\w+)'/.exec(body)?.[1]
    })
    assert.deepEqual(found, SEVERITY)
})
