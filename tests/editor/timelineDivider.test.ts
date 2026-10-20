import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { dividerLabel } from '../../src/editor/history/dividerLabel'
import type { Entry } from '../../src/editor/history/rows'
import type { OperationTextContext } from '../../src/history/operationPresentation'
import { captureName, type EntryDescription } from '../../src/history/operations'
import { formatDateTime } from '../../src/i18n/dateTime'
import { futureFixtureOperation, nativeOperation } from '../helpers/historySteps'

// A boundary divider names what its own entry holds (X-10): an opened file reads "Opened <file>"
// and a continuation the time it continued from, never the entry's own time.

const locales = ['en', 'fr', 'ja', 'ko', 'tr', 'zhs', 'zht'] as const
const now = new Date(2026, 9, 20, 9).getTime()
const context = (locale: string): OperationTextContext => ({
    locale,
    strings: JSON.parse(
        readFileSync(new URL(`../../src/i18n/${locale}/index.json`, import.meta.url), 'utf8'),
    ),
    now,
})
const minute = (locale: string) => (at: number) => formatDateTime(locale, at, now)

const opened = new Date(2026, 9, 20, 8, 22).getTime()
const continuedFrom = new Date(2026, 9, 20, 6, 33, 41).getTime()
const ownStart = new Date(2026, 9, 20, 8, 1).getTime()

const entry = (description: EntryDescription, time: number, extra: Partial<Entry> = {}) =>
    ({ sessionId: 's', seq: 1, time, kept: true, ...description, ...extra }) as Entry
const continueEntry = (fromTime: number, extra: Partial<Entry> = {}) =>
    entry(
        {
            kind: 'continue',
            operation: nativeOperation({ id: 'nse.continue', data: { fromTime } }, 'Continued'),
        },
        ownStart,
        extra,
    )
const openEntry = (source = 'x-a.nxsp', extra: Partial<Entry> = {}) =>
    entry(
        {
            kind: 'continue',
            operation: nativeOperation(
                { id: 'nse.origin', data: { origin: 'import', source: captureName(source) } },
                'Opened',
            ),
        },
        opened,
        extra,
    )

test('an open’s divider names the file in every locale', () => {
    for (const locale of locales) {
        const ctx = context(locale)
        const text = dividerLabel(openEntry(), ctx, minute(locale))
        assert.equal(
            text,
            ctx.strings.history.openedFile.replace('{0}', 'x-a.nxsp'),
            `${locale}: "${text}"`,
        )
    }
})

test('a continuation names the time it continued from, to the minute, not its own time', () => {
    for (const locale of locales) {
        const ctx = context(locale)
        const expected = ctx.strings.history.continuedFrom.replace(
            '{0}',
            formatDateTime(locale, continuedFrom, now),
        )
        // Opened from a file: one session, no parent link, so no `from`.
        assert.equal(dividerLabel(continueEntry(continuedFrom), ctx, minute(locale)), expected)
        // A stored chain's parent lookup does not override the entry's own operation.
        assert.equal(
            dividerLabel(continueEntry(continuedFrom, { from: ownStart }), ctx, minute(locale)),
            expected,
        )
        assert(
            !dividerLabel(continueEntry(continuedFrom), ctx, minute(locale)).includes(
                formatDateTime(locale, ownStart, now),
            ),
        )
    }
    assert.equal(
        dividerLabel(continueEntry(continuedFrom), context('en'), minute('en')),
        'Continued from Oct 20, 6:33 AM',
    )
})

test('the open’s divider keeps its name with a parent time; an unknown continuation uses that time', () => {
    const en = context('en')
    assert.equal(
        dividerLabel(openEntry('coconut.nxsp', { from: continuedFrom }), en, minute('en')),
        'Opened coconut.nxsp',
    )
    const future = entry({ kind: 'continue', operation: futureFixtureOperation('cont') }, ownStart)
    assert.equal(
        dividerLabel({ ...future, from: continuedFrom }, en, minute('en')),
        'Continued from Oct 20, 6:33 AM',
    )
    // Nothing to tell when: its own description, never its own time as a "from".
    assert.equal(dividerLabel(future, en, minute('en')), 'cont')
})
