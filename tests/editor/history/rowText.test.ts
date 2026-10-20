import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mock, test } from 'node:test'
import { resolveZone } from '../../../src/calendar/calendar'
import { calendarAt } from '../../../src/editor/history/calendarClock'
import { historyFormat } from '../../../src/editor/history/historyFormat'
import { dividerText, rowName, rowTime, rowTitle } from '../../../src/editor/history/rowText'
import type { Entry } from '../../../src/editor/history/rows'
import type { OperationTextContext } from '../../../src/history/operationPresentation/types'
import { captureName } from '../../../src/history/operations'
import { nativeOperation } from '../../helpers/historySteps'

// I-12: a row's time, title, name and divider are all written from the one Calendar they are
// given. The host runs in Kiritimati and the real clock is stubbed to the year 2000, so a text from
// either would show.
process.env.TZ = 'Pacific/Kiritimati'

const newYork = resolveZone('America/New_York')
const tokyo = resolveZone('Asia/Tokyo')
const nbsp = (text: string) => text.replace(/[\u202f\u00a0\u2009]/g, ' ')

const strings = JSON.parse(
    readFileSync(new URL('../../../src/i18n/en/index.json', import.meta.url), 'utf8'),
) as OperationTextContext['strings']

// 2026-10-20 18:41:07 UTC.
const at = Date.UTC(2026, 9, 20, 18, 41, 7)
const continuedFrom = Date.UTC(2026, 9, 20, 6, 33, 41)

const contextOf = (cal: ReturnType<typeof calendarAt>): OperationTextContext => ({
    locale: 'en',
    strings,
    now: cal.now,
    zone: cal.zone,
})

const entry = (extra: Partial<Entry>) =>
    ({ sessionId: 's', seq: 1, time: at, kept: true, ...extra }) as Entry
const continueEntry = (fromTime: number) =>
    entry({
        kind: 'continue',
        operation: nativeOperation({ id: 'nse.continue', data: { fromTime } }, 'Continued'),
    })
const openEntry = () =>
    entry({
        kind: 'continue',
        operation: nativeOperation(
            { id: 'nse.origin', data: { origin: 'import', source: captureName('x-a.nxsp') } },
            'Opened',
        ),
    })

test('a row’s time is the clock in the calendar’s zone, with seconds unless the row is narrow', () => {
    const wide = historyFormat(calendarAt(at, newYork), 'en')
    assert.equal(nbsp(rowTime(wide, at, false)), '2:41:07 PM')
    assert.equal(nbsp(rowTime(wide, at, true)), '2:41 PM')
    const asia = historyFormat(calendarAt(at, tokyo), 'en')
    assert.equal(nbsp(rowTime(asia, at, false)), '3:41:07 AM')
    assert.equal(nbsp(rowTime(asia, at, true)), '3:41 AM')
})

test('a row’s title and name end with the full date and time in the calendar’s zone', () => {
    const parts = { label: 'Added 3 notes', flag: undefined as string | undefined }
    const format = historyFormat(calendarAt(Date.UTC(2026, 9, 22), newYork), 'en')
    assert.equal(nbsp(rowTitle(format, at, parts)), 'Added 3 notes · Oct 20, 2:41:07 PM')
    assert.equal(
        nbsp(rowTitle(format, at, { ...parts, flag: 'Removed for space' })),
        'Added 3 notes · Removed for space · Oct 20, 2:41:07 PM',
    )
    assert.equal(
        nbsp(rowName(format, at, { ...parts, flag: undefined, delta: '+3' })),
        'Added 3 notes, +3, Oct 20, 2:41:07 PM',
    )
    const asia = historyFormat(calendarAt(Date.UTC(2026, 9, 22), tokyo), 'en')
    assert.equal(nbsp(rowTitle(asia, at, parts)), 'Added 3 notes · Oct 21, 3:41:07 AM')
})

test('a divider names the time it continued from in the calendar’s zone, not the engine’s or the real clock’s', () => {
    mock.method(Date, 'now', () => Date.UTC(2000, 0, 1))
    try {
        for (const [zone, expected] of [
            [newYork, 'Continued from Oct 20, 2:33 AM'],
            [tokyo, 'Continued from Oct 20, 3:33 PM'],
            [newYork, 'Continued from Oct 20, 2:33 AM'],
        ] as const) {
            const cal = calendarAt(at, zone)
            const text = dividerText(
                historyFormat(cal, 'en'),
                contextOf(cal),
                continueEntry(continuedFrom),
            )
            assert.equal(nbsp(text), expected, zone)
        }
        // An open names its file and no date.
        const cal = calendarAt(at, newYork)
        assert.equal(
            dividerText(historyFormat(cal, 'en'), contextOf(cal), openEntry()),
            strings.history.openedFile.replace('{0}', 'x-a.nxsp'),
        )
    } finally {
        mock.restoreAll()
    }
})

test('a divider’s year follows the calendar’s clock, not the real one', () => {
    mock.method(Date, 'now', () => Date.UTC(2000, 0, 1))
    try {
        const cal = calendarAt(Date.UTC(2029, 5, 1), newYork)
        const text = dividerText(
            historyFormat(cal, 'en'),
            contextOf(cal),
            continueEntry(continuedFrom),
        )
        assert.match(text, /2026/)
        const same = calendarAt(Date.UTC(2026, 11, 1), newYork)
        assert.doesNotMatch(
            dividerText(historyFormat(same, 'en'), contextOf(same), continueEntry(continuedFrom)),
            /2026/,
        )
    } finally {
        mock.restoreAll()
    }
})
