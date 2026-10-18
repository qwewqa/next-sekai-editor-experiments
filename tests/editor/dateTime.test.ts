import assert from 'node:assert/strict'
import test from 'node:test'
import { formatClock, formatDate, formatDateTime, formatWhen } from '../../src/i18n/dateTime'

const at = (month: number, day: number, hour = 14, minute = 41, year = 2026) =>
    new Date(year, month - 1, day, hour, minute).getTime()
const now = at(10, 16, 9, 0)

test('a date is the short month and day, with the year only in another year', () => {
    assert.equal(formatDate('en', at(10, 15), now), 'Oct 15')
    assert.equal(formatDate('en', at(10, 15, 14, 41, 2025), now), 'Oct 15, 2025')
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
