import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DayKey } from '../../src/calendar/calendar'
import { NO_USE_DAY, type UseDay } from '../../src/local/days'
import { useDay } from '../helpers/useDay'

// A day of use is not a calendar day. These are checked by `npm run check-type`: an unused
// `@ts-expect-error` is an error, so the brands have to keep the two apart.

const takesUseDay = (day: UseDay) => day
const takesDayKey = (day: DayKey) => day

test('a calendar DayKey is not a UseDay, and a UseDay is not a DayKey', () => {
    const key = 20_000 as DayKey
    // @ts-expect-error a DayKey is not a UseDay
    takesUseDay(key)
    // @ts-expect-error a UseDay is not a DayKey
    takesDayKey(useDay(3))
    // @ts-expect-error a plain number is not a UseDay
    takesUseDay(3)
    assert.equal(takesUseDay(useDay(3)), 3)
    assert.equal(takesDayKey(key), 20_000)
})

test('NO_USE_DAY is day zero, before any day of use', () => {
    assert.equal(NO_USE_DAY, 0)
    assert.equal(takesUseDay(NO_USE_DAY), 0)
})
