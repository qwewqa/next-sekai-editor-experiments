import assert from 'node:assert/strict'
import test from 'node:test'
import {
    formatClock,
    formatClockRange,
    formatDate,
    formatDateInSentence,
    formatDateTime,
    formatEntryTime,
    formatHour,
    formatWhen,
} from '../../src/i18n/dateTime'

const at = (month: number, day: number, hour = 14, minute = 41, year = 2026) =>
    new Date(year, month - 1, day, hour, minute).getTime()
const now = at(10, 16, 9, 0)

test('a date is the short month and day, with the year only in another year', () => {
    assert.equal(formatDate('en', at(10, 15), now), 'Oct 15')
    assert.equal(formatDate('en', at(10, 15, 14, 41, 2025), now), 'Oct 15, 2025')
})

test('a date in a sentence joins its parts with no-break spaces', () => {
    assert.equal(formatDateInSentence('en', at(10, 15), now), 'Oct\u00A015')
    assert.equal(
        formatDateInSentence('en', at(10, 15, 14, 41, 2025), now),
        'Oct\u00A015,\u00A02025',
    )
    assert.equal(formatDateInSentence('fr', at(10, 19), now), '19\u00A0oct.')
    assert.doesNotMatch(formatDateInSentence('ja', at(10, 15), now), / /)
})

test('a date in a sentence is the time when it was today', () => {
    assert.equal(
        formatDateInSentence('en', at(10, 16), now).replaceAll(/\p{Zs}/gu, ' '),
        formatClock('en', at(10, 16)).replaceAll(/\p{Zs}/gu, ' '),
    )
    assert.doesNotMatch(formatDateInSentence('en', at(10, 16), now), /Oct/)
    assert.equal(formatDateInSentence('fr', at(10, 16), now), '14:41')
})

test('the French sentences that carry a date do not end on it, whose abbreviation point would double', async () => {
    const { default: fr } = await import('../../src/i18n/fr/index.json', { with: { type: 'json' } })
    assert.match(formatDateInSentence('fr', at(10, 19), now), /\.$/)
    for (const text of [fr.load.continued, fr.load.continuedUntitled, fr.open.unsavedChanges])
        assert.doesNotMatch(text, /\{\d\}\.$/)
})

test('a time of day and a date with a time follow the locale', () => {
    assert.equal(formatClock('en', at(10, 16)), '2:41 PM')
    assert.equal(formatDateTime('en', at(10, 16), now), 'Oct 16, 2:41 PM')
    assert.match(formatDateTime('en', at(10, 16, 14, 41, 2025), now), /2025/)
    assert.match(formatDateTime('fr', at(10, 16), now), /14:41/)
    assert.match(formatDate('ja', at(10, 15), now), /10月15日/)
})

test('a file event shows the time when it was today and the date otherwise', () => {
    assert.equal(formatWhen('en', at(10, 16, 2, 5), now), '2:05 AM')
    assert.equal(formatWhen('en', at(10, 14), now), 'Oct 14')
    assert.equal(formatWhen('en', at(10, 15, 23, 59), at(10, 16, 0, 1)), 'Oct 15')
})

test('locale codes that are not language tags still format', () => {
    assert.match(formatDate('zhs', at(10, 15), now), /10月15日/)
    assert.match(formatDate('zht', at(10, 15), now), /10月15日/)
})

test('an entry shows its time to the second, with the date when it is not from today', () => {
    assert.equal(formatEntryTime('en', at(10, 16, 14, 41), now), '2:41:00 PM')
    assert.equal(formatEntryTime('en', at(10, 14, 17, 2), now), 'Oct 14, 5:02:00 PM')
    assert.match(formatEntryTime('en', at(10, 14, 17, 2, 2025), now), /Oct 14, 2025/)
})

test('an hour header is the hour alone', () => {
    assert.equal(formatHour('en', at(10, 16, 13, 40)), '1 PM')
    assert.match(formatHour('fr', at(10, 16, 13, 40)), /13/)
})

test('a clock range puts the earlier time first, whatever order it is given in', () => {
    const early = at(10, 16, 16, 16)
    const late = at(10, 16, 16, 33)
    const range = formatClockRange('en', early, late)
    assert.match(range, /4:16/)
    assert.equal(formatClockRange('en', late, early), range)
    assert.ok(range.indexOf('4:16') < range.indexOf('4:33'))
})

test('a clock range never throws', () => {
    assert.equal(formatClockRange('en', Number.NaN, at(10, 16, 16, 16)), '')
    assert.doesNotThrow(() => formatClockRange('en', at(10, 16, 16, 33), at(10, 16, 16, 16)))
})

test("a time without a zone follows a change of the engine's zone", () => {
    const original = process.env.TZ
    const instant = Date.UTC(2026, 10, 5, 1, 30)
    try {
        process.env.TZ = 'America/Los_Angeles'
        assert.equal(formatDateTime('en', instant, instant), 'Nov 4, 5:30 PM')
        assert.equal(formatClock('en', instant), '5:30 PM')
        process.env.TZ = 'Asia/Tokyo'
        assert.equal(formatDateTime('en', instant, instant), 'Nov 5, 10:30 AM')
        assert.equal(formatClock('en', instant), '10:30 AM')
    } finally {
        if (original === undefined) delete process.env.TZ
        else process.env.TZ = original
    }
})
